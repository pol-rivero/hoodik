#[path = "./helpers.rs"]
mod helpers;

use actix_web::{cookie::Cookie, http::StatusCode, test};
use entity::{files, ActiveValue, EntityTrait, Uuid};
use hoodik::server;
use serde_json::{json, Value};
use storage::data::{app_file::AppFile, response::Response};

async fn create(app: &impl helpers::TestApp, jwt: &Cookie<'static>, body: Value) -> (StatusCode, Value) {
    let req = test::TestRequest::post()
        .uri("/api/storage")
        .cookie(jwt.clone())
        .set_json(body)
        .to_request();
    let resp = test::call_service(app, req).await;
    let status = resp.status();
    let body = test::read_body(resp).await;
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

fn base(name: &str, mime: &str, parent: Option<Uuid>) -> Value {
    let mut body = json!({
        "encrypted_key": "key",
        "encrypted_name": name,
        "name_hash": helpers::name_tag(name),
        "mime": mime,
        "file_id": parent,
    });
    if mime != "dir" && mime != "shortcut" {
        body["size"] = json!(10);
        body["chunks"] = json!(1);
    }
    body
}

fn shortcut(name: &str, target: Uuid, parent: Option<Uuid>) -> Value {
    let mut body = base(name, "shortcut", parent);
    body["shortcut_target_id"] = json!(target);
    body
}

async fn created(app: &impl helpers::TestApp, jwt: &Cookie<'static>, body: Value) -> AppFile {
    let (status, body) = create(app, jwt, body).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_value(body).unwrap()
}

async fn list(app: &impl helpers::TestApp, jwt: &Cookie<'static>, dir: Option<Uuid>) -> Vec<AppFile> {
    let uri = match dir {
        Some(id) => format!("/api/storage?dir_id={id}"),
        None => "/api/storage".to_string(),
    };
    let req = test::TestRequest::get().uri(&uri).cookie(jwt.clone()).to_request();
    let response: Response = test::call_and_read_body_json(app, req).await;
    response.children
}

async fn trash(app: &impl helpers::TestApp, jwt: &Cookie<'static>, id: Uuid) {
    let req = test::TestRequest::delete()
        .uri(&format!("/api/storage/{id}"))
        .cookie(jwt.clone())
        .to_request();
    assert_eq!(test::call_service(app, req).await.status(), StatusCode::NO_CONTENT);
}

#[actix_web::test]
async fn shortcut_lists_with_its_target_and_breaks_when_target_is_trashed() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    let jwt = helpers::register_curve25519(&app, "shortcut@test.com").await.jwt;

    let folder = created(&app, &jwt, base("folder", "dir", None)).await;
    let file = created(&app, &jwt, base("report.pdf", "application/pdf", None)).await;

    let to_file = created(&app, &jwt, shortcut("report.pdf", file.id, Some(folder.id))).await;
    let to_folder = created(&app, &jwt, shortcut("folder link", folder.id, None)).await;

    assert_eq!(to_file.mime, "shortcut");
    assert!(to_file.finished_upload_at.is_some(), "a shortcut is never an upload in flight");
    assert_eq!(to_file.chunks, None);

    let inside = list(&app, &jwt, Some(folder.id)).await;
    let listed = inside.iter().find(|f| f.id == to_file.id).unwrap();
    assert_eq!(listed.shortcut_target_id, Some(file.id));
    assert_eq!(listed.shortcut_target_mime.as_deref(), Some("application/pdf"));

    let root = list(&app, &jwt, None).await;
    let listed = root.iter().find(|f| f.id == to_folder.id).unwrap();
    assert_eq!(listed.shortcut_target_mime.as_deref(), Some("dir"));

    // Trashed by hand with a distant purge date: this instance purges at
    // once, which would delete the shortcut along with its target.
    let now = chrono::Utc::now().timestamp();
    files::Entity::update(files::ActiveModel {
        id: ActiveValue::Unchanged(file.id),
        trashed_at: ActiveValue::Set(Some(now)),
        trash_root_id: ActiveValue::Set(Some(file.id)),
        purge_at: ActiveValue::Set(Some(now + 86_400)),
        ..Default::default()
    })
    .exec(&context.db)
    .await
    .unwrap();
    let inside = list(&app, &jwt, Some(folder.id)).await;
    let listed = inside.iter().find(|f| f.id == to_file.id).unwrap();
    assert_eq!(listed.shortcut_target_mime, None, "a trashed target leaves the shortcut broken");
}

#[actix_web::test]
async fn purging_the_target_deletes_its_shortcuts() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    let jwt = helpers::register_curve25519(&app, "purge@test.com").await.jwt;

    let file = created(&app, &jwt, base("a.txt", "text/plain", None)).await;
    let link = created(&app, &jwt, shortcut("a.txt link", file.id, None)).await;

    trash(&app, &jwt, file.id).await;
    let req = test::TestRequest::post()
        .uri("/api/storage/trash/purge")
        .cookie(jwt.clone())
        .set_json(json!({ "ids": [file.id] }))
        .to_request();
    assert!(test::call_service(&app, req).await.status().is_success());
    storage::trash::purge_due(&context).await;

    assert!(files::Entity::find_by_id(file.id).one(&context.db).await.unwrap().is_none());
    assert!(files::Entity::find_by_id(link.id).one(&context.db).await.unwrap().is_none());
}

#[actix_web::test]
async fn shortcut_targets_are_validated() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    let alice = helpers::register_curve25519(&app, "alice-sc@test.com").await.jwt;
    let bob = helpers::register_curve25519(&app, "bob-sc@test.com").await.jwt;

    let file = created(&app, &alice, base("mine.txt", "text/plain", None)).await;
    let link = created(&app, &alice, shortcut("mine link", file.id, None)).await;

    let (status, _) = create(&app, &alice, base("no target", "shortcut", None)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let mut stray = base("stray.txt", "text/plain", None);
    stray["shortcut_target_id"] = json!(file.id);
    let (status, _) = create(&app, &alice, stray).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (status, _) = create(&app, &alice, shortcut("chain", link.id, None)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = create(&app, &bob, shortcut("not mine", file.id, None)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = create(&app, &alice, shortcut("ghost", Uuid::new_v4(), None)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[actix_web::test]
async fn shortcut_has_no_content_to_upload() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    let jwt = helpers::register_curve25519(&app, "content@test.com").await.jwt;

    let file = created(&app, &jwt, base("b.txt", "text/plain", None)).await;
    let link = created(&app, &jwt, shortcut("b link", file.id, None)).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/storage/{}?chunk=0", link.id))
        .cookie(jwt.clone())
        .set_payload("hello")
        .to_request();
    assert!(test::call_service(&app, req).await.status().is_client_error());
}
