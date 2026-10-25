use std::sync::Arc;

use actix_web::{route, web, HttpResponse};
use auth::data::claims::Claims;
use chrono::Utc;
use context::Context;
use entity::{
    files,
    permission::{permissions_for_including_trashed, SharePermission},
    ColumnTrait, EntityTrait, QueryFilter, TransactionTrait, Uuid,
};
use error::{AppResult, Error};

use crate::{
    data::delete_many::DeleteMany,
    repository::{cached, Repository},
};

/// Bulk delete. Each id is dispatched by the caller's row on it: owner ids
/// move to the trash, non-owner ids self-remove, ids already in the trash
/// are left alone, and an id with no row fails the whole batch. All in one
/// DB transaction, so a failure leaves every requested target as it was.
#[route("/api/storage/delete-many", method = "POST")]
pub(crate) async fn delete_many(
    claims: Claims,
    context: web::Data<Context>,
    data: web::Json<DeleteMany>,
) -> AppResult<HttpResponse> {
    let ids = data.into_inner().into_value()?;

    delete_ids(context.into_inner(), claims.sub, &ids).await?;

    Ok(HttpResponse::NoContent().finish())
}

/// The shared body of both delete routes.
pub(crate) async fn delete_ids(
    context: Arc<Context>,
    user_id: Uuid,
    ids: &[Uuid],
) -> AppResult<()> {
    let now = Utc::now().timestamp();
    let retention_days = context.settings.inner().await.trash.retention_days();
    let purge_at = now + retention_days * 86_400;

    let connection = context.db.begin().await?;

    let perms = permissions_for_including_trashed(&connection, ids, user_id).await?;
    let mut to_trash: Vec<Uuid> = Vec::new();
    let mut to_self_remove: Vec<Uuid> = Vec::new();
    for id in ids {
        match perms
            .get(id)
            .copied()
            .unwrap_or((SharePermission::None, false))
        {
            (SharePermission::None, _) => {
                return Err(Error::Forbidden("forbidden_not_owner".to_string()));
            }
            (_, true) => {}
            (SharePermission::Owner, false) => to_trash.push(*id),
            (
                SharePermission::CoOwner | SharePermission::Editor | SharePermission::Reader,
                false,
            ) => to_self_remove.push(*id),
        }
    }

    let repository = Repository::new(&connection);
    let trash = repository.trash(user_id);
    let roots = trash.roots(&to_trash).await?;
    let unfinished = unfinished_uploads(&connection, &roots).await?;
    for root in &roots {
        // An abandoned upload is no use to anyone in the trash; it goes
        // straight to purge so cancelling an upload still frees the space.
        let root_purge_at = match unfinished.contains(root) {
            true => 0,
            false => purge_at,
        };
        trash.trash(*root, now, root_purge_at).await?;
    }

    if !to_self_remove.is_empty() {
        repository
            .manage(user_id)
            .self_remove_recursive(to_self_remove)
            .await?;
    }
    connection.commit().await?;

    if !roots.is_empty() {
        cached::evict_all().await;
    }
    crate::trash::spawn_purge(context, unfinished);

    Ok(())
}

/// Files among `ids` whose initial upload started and never finished.
/// Zero-chunk files never finish by design, so they don't count.
async fn unfinished_uploads<C: entity::ConnectionTrait>(
    connection: &C,
    ids: &[Uuid],
) -> AppResult<Vec<Uuid>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    Ok(files::Entity::find()
        .filter(files::Column::Id.is_in(ids.iter().copied()))
        .filter(files::Column::Mime.ne("dir"))
        .filter(files::Column::Chunks.gt(0))
        .filter(files::Column::FinishedUploadAt.is_null())
        .all(connection)
        .await?
        .into_iter()
        .map(|file| file.id)
        .collect())
}
