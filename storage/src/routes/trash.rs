//! The caller's trash: list, restore, delete forever and empty.

use actix_web::{route, web, HttpResponse};
use auth::data::claims::Claims;
use chrono::Utc;
use context::Context;
use entity::TransactionTrait;
use error::AppResult;

use crate::{
    data::trash::{TrashIds, TrashList, TrashQuery},
    repository::{cached, Repository},
};

/// The items the caller trashed and can still restore, newest first.
///
/// Response: [crate::data::trash::TrashList]
#[route("/api/storage/trash", method = "GET")]
pub(crate) async fn list(
    claims: Claims,
    context: web::Data<Context>,
    query: web::Query<TrashQuery>,
) -> AppResult<HttpResponse> {
    let items = Repository::new(&context.db)
        .trash(claims.sub)
        .list(query.compact.unwrap_or(false), Utc::now().timestamp())
        .await?;

    Ok(HttpResponse::Ok().json(TrashList { items }))
}

/// Restore trash items, each into its original folder when that is still
/// there and writable, otherwise into the caller's root.
///
/// Request: [crate::data::trash::TrashIds]
///
/// Response: [crate::data::trash::RestoreResponse]
#[route("/api/storage/trash/restore", method = "POST")]
pub(crate) async fn restore(
    claims: Claims,
    context: web::Data<Context>,
    data: web::Json<TrashIds>,
) -> AppResult<HttpResponse> {
    let ids = data.into_inner().into_value()?;

    let connection = context.db.begin().await?;
    let response = Repository::new(&connection)
        .trash(claims.sub)
        .restore(&ids, Utc::now().timestamp())
        .await?;
    connection.commit().await?;

    cached::evict_all().await;

    Ok(HttpResponse::Ok().json(response))
}

/// Delete trash items forever. They stop being restorable at once and are
/// purged in the background; ids that are not the caller's trash items are
/// ignored.
///
/// Request: [crate::data::trash::TrashIds]
#[route("/api/storage/trash/purge", method = "POST")]
pub(crate) async fn purge(
    claims: Claims,
    context: web::Data<Context>,
    data: web::Json<TrashIds>,
) -> AppResult<HttpResponse> {
    let ids = data.into_inner().into_value()?;

    let roots = Repository::new(&context.db)
        .trash(claims.sub)
        .mark_due(&ids)
        .await?;
    crate::trash::spawn_purge(context.into_inner(), roots);

    Ok(HttpResponse::Accepted().finish())
}

/// Delete everything in the caller's trash forever. Same as purging every
/// item in it.
#[route("/api/storage/trash/empty", method = "POST")]
pub(crate) async fn empty(claims: Claims, context: web::Data<Context>) -> AppResult<HttpResponse> {
    let roots = Repository::new(&context.db)
        .trash(claims.sub)
        .mark_all_due()
        .await?;
    crate::trash::spawn_purge(context.into_inner(), roots);

    Ok(HttpResponse::Accepted().finish())
}
