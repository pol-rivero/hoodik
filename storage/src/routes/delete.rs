use actix_web::{route, web, HttpRequest, HttpResponse};
use auth::data::claims::Claims;
use context::Context;
use entity::Uuid;
use error::AppResult;

use super::delete_many::delete_ids;

/// Delete a file or directory by id. Owner → move to the trash (with the
/// whole subtree). Reader / Editor / Co-owner → self-remove only (drop the
/// caller's `user_files` row, recursively for folders). Already in the
/// trash → no-op. No row → 401.
#[route("/api/storage/{file_id}", method = "DELETE")]
pub(crate) async fn delete(
    req: HttpRequest,
    claims: Claims,
    context: web::Data<Context>,
) -> AppResult<HttpResponse> {
    let file_id: Uuid = util::actix::path_var(&req, "file_id")?;

    delete_ids(context.into_inner(), claims.sub, &[file_id]).await?;

    Ok(HttpResponse::NoContent().finish())
}
