use actix_web::{route, web, HttpResponse};
use auth::data::claims::Claims;
use context::Context;
use error::AppResult;

use crate::{
    data::largest::{LargestList, LargestQuery},
    repository::Repository,
};

/// The caller's largest owned files, biggest first, in the compact projection.
///
/// Response: [crate::data::largest::LargestList]
#[route("/api/storage/largest", method = "GET")]
pub(crate) async fn largest(
    claims: Claims,
    context: web::Data<Context>,
    query: web::Query<LargestQuery>,
) -> AppResult<HttpResponse> {
    let items = Repository::new(&context.db)
        .query(claims.sub)
        .largest(query.limit())
        .await?;

    Ok(HttpResponse::Ok().json(LargestList { items }))
}
