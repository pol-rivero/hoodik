//! Trash through the real storage routes: deleting moves an item to its
//! owner's trash, the item disappears from every read path, and restore,
//! delete-forever and empty-trash act on it. The background purge is not
//! running here; tests call `storage::trash::purge_due` themselves.

#[macro_use]
#[path = "./shares_common.rs"]
mod shares_common;

use actix_web::{http::StatusCode, test};
use entity::{
    file_tokens, file_versions, files, links, user_files, ActiveValue, ColumnTrait, EntityTrait,
    PaginatorTrait, QueryFilter, Uuid,
};
use fs::prelude::{Fs, FsProviderContract};
use hoodik::server;
use serde_json::{json, Value};
use storage::data::{app_file::AppFile, response::Response as Listing};

use crate::shares_common::*;

const DAY: i64 = 86_400;

fn name_tag(name: &str) -> String {
    cryptfns::search::tag(&[7u8; 32], name).expect("tag a fixture name")
}

async fn send(app: &impl TestApp, req: actix_http::Request) -> (StatusCode, Value) {
    let resp = test::call_service(app, req).await;
    let status = resp.status();
    let body = test::read_body(resp).await;
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn get(app: &impl TestApp, user: &TestUser, uri: &str) -> (StatusCode, Value) {
    let req = test::TestRequest::get()
        .uri(uri)
        .cookie(user.jwt.clone())
        .to_request();
    send(app, req).await
}

async fn post(app: &impl TestApp, user: &TestUser, uri: &str, body: Value) -> (StatusCode, Value) {
    let req = test::TestRequest::post()
        .uri(uri)
        .cookie(user.jwt.clone())
        .set_json(body)
        .to_request();
    send(app, req).await
}

async fn delete(app: &impl TestApp, user: &TestUser, id: Uuid) -> StatusCode {
    let req = test::TestRequest::delete()
        .uri(&format!("/api/storage/{id}"))
        .cookie(user.jwt.clone())
        .to_request();
    send(app, req).await.0
}

async fn create(
    app: &impl TestApp,
    user: &TestUser,
    payload: storage::data::create_file::CreateFile,
) -> AppFile {
    let req = test::TestRequest::post()
        .uri("/api/storage")
        .cookie(user.jwt.clone())
        .set_json(&payload)
        .to_request();
    let (status, body) = send(app, req).await;
    assert_eq!(status, StatusCode::OK, "create failed: {body}");
    serde_json::from_value(body).unwrap()
}

async fn folder(app: &impl TestApp, user: &TestUser, name: &str, parent: Option<Uuid>) -> AppFile {
    create(app, user, make_create_folder(user, &name_tag(name), parent)).await
}

/// A file created but never uploaded: one chunk declared, none sent.
async fn empty_file(
    app: &impl TestApp,
    user: &TestUser,
    name: &str,
    parent: Option<Uuid>,
) -> AppFile {
    let mut payload = make_create_file_for(user, &name_tag(name));
    payload.file_id = parent.map(|p| p.to_string());
    create(app, user, payload).await
}

/// A fully uploaded one-chunk file, indexed for search under its name.
async fn upload(app: &impl TestApp, user: &TestUser, name: &str, parent: Option<Uuid>) -> AppFile {
    let data = format!("encrypted bytes of {name}").into_bytes();
    let mut payload = make_create_file_for(user, &name_tag(name));
    payload.size = Some(data.len() as i64);
    payload.file_id = parent.map(|p| p.to_string());
    payload.search_tokens_root = Some(storage::mock::index_tags(
        &storage::mock::search_key(),
        name,
    ));
    let file = create(app, user, payload).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/storage/{}?chunk=0", file.id))
        .cookie(user.jwt.clone())
        .append_header(("Content-Type", "application/octet-stream"))
        .set_payload(data)
        .to_request();
    let (status, body) = send(app, req).await;
    assert_eq!(status, StatusCode::OK, "chunk upload failed: {body}");
    let file: AppFile = serde_json::from_value(body).unwrap();
    assert!(file.finished_upload_at.is_some());
    file
}

async fn trash_list(app: &impl TestApp, user: &TestUser) -> Vec<AppFile> {
    let (status, body) = get(app, user, "/api/storage/trash?compact=true").await;
    assert_eq!(status, StatusCode::OK, "trash list failed: {body}");
    serde_json::from_value(body["items"].clone()).unwrap()
}

async fn root_listing(app: &impl TestApp, user: &TestUser) -> Vec<Uuid> {
    let (status, body) = get(app, user, "/api/storage").await;
    assert_eq!(status, StatusCode::OK);
    let listing: Listing = serde_json::from_value(body).unwrap();
    listing.children.into_iter().map(|f| f.id).collect()
}

async fn row(context: &context::Context, id: Uuid) -> Option<files::Model> {
    files::Entity::find_by_id(id)
        .one(&context.db)
        .await
        .unwrap()
}

async fn chunks_on_disk(context: &context::Context, file: &AppFile) -> Vec<i64> {
    Fs::new(&context.config)
        .get_uploaded_chunks(file)
        .await
        .unwrap()
}

async fn set_retention(app: &impl TestApp, admin: &TestUser, days: Value) -> StatusCode {
    let (_, mut settings) = get(app, admin, "/api/admin/settings").await;
    settings["trash"] = json!({ "retention_days": days });
    let req = test::TestRequest::put()
        .uri("/api/admin/settings")
        .cookie(admin.jwt.clone())
        .set_json(settings)
        .to_request();
    send(app, req).await.0
}

#[actix_web::test]
async fn a_deleted_file_disappears_everywhere_and_comes_back_on_restore() {
    let context =
        context::Context::mock_with_data_dir(Some("../data/test-trash-roundtrip".to_string()))
            .await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");

    let file = upload(&app, &alice, "octopus", None).await;
    let search =
        json!({ "root_tags": storage::mock::query_tags(&storage::mock::search_key(), "octopus") });
    let (_, hits) = post(&app, &alice, "/api/storage/search", search.clone()).await;
    assert_eq!(hits.as_array().unwrap().len(), 1);

    assert_eq!(delete(&app, &alice, file.id).await, StatusCode::NO_CONTENT);

    assert!(!root_listing(&app, &alice).await.contains(&file.id));
    let (_, hits) = post(&app, &alice, "/api/storage/search", search.clone()).await;
    assert!(
        hits.as_array().unwrap().is_empty(),
        "trashed file is not searchable"
    );
    let (status, _) = get(
        &app,
        &alice,
        &format!("/api/storage/{}/name-hash", file.name_hash),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    for uri in [
        format!("/api/storage/{}/metadata", file.id),
        format!("/api/storage/{}", file.id),
        format!("/api/storage/{}/thumbnail", file.id),
    ] {
        assert_eq!(
            get(&app, &alice, &uri).await.0,
            StatusCode::NOT_FOUND,
            "{uri}"
        );
    }
    assert_eq!(
        chunks_on_disk(&context, &file).await,
        vec![0],
        "trash keeps the bytes"
    );

    // The trash route is not taken by `GET /api/storage/{file_id}`.
    let items = trash_list(&app, &alice).await;
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.id, file.id);
    assert_eq!(item.trash_root_id, Some(file.id));
    let trashed_at = item.trashed_at.expect("trashed_at is set");
    assert_eq!(item.purge_at, Some(trashed_at + 30 * DAY));
    assert!(item.encrypted_thumbnail.is_none(), "compact listing");
    let (status, raw) = get(&app, &alice, "/api/storage/trash").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(raw["items"][0]["trash_root_id"], json!(file.id));

    let (status, body) = post(
        &app,
        &alice,
        "/api/storage/trash/restore",
        json!({ "ids": [file.id] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({
            "restored": [{ "id": file.id, "file_id": null, "relocated": false }],
            "conflicts": [],
            "missing": [],
        })
    );

    assert!(trash_list(&app, &alice).await.is_empty());
    assert!(root_listing(&app, &alice).await.contains(&file.id));
    let (status, metadata) = get(&app, &alice, &format!("/api/storage/{}/metadata", file.id)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(metadata["trashed_at"], Value::Null);
    assert_eq!(metadata["trash_root_id"], Value::Null);
    assert_eq!(metadata["purge_at"], Value::Null);
    let req = test::TestRequest::get()
        .uri(&format!("/api/storage/{}", file.id))
        .cookie(alice.jwt.clone())
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        test::read_body(resp).await.to_vec(),
        b"encrypted bytes of octopus".to_vec()
    );
    let (_, hits) = post(&app, &alice, "/api/storage/search", search).await;
    assert_eq!(hits.as_array().unwrap().len(), 1);

    Fs::new(&context.config).purge_all(&file).await.unwrap();
    context.config.app.cleanup();
}

#[actix_web::test]
async fn deleting_is_idempotent_and_a_bad_id_fails_the_whole_batch() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");

    let first = empty_file(&app, &alice, "first", None).await;
    let second = empty_file(&app, &alice, "second", None).await;
    let third = empty_file(&app, &alice, "third", None).await;
    // Marked uploaded, or the delete would purge them as abandoned uploads.
    for file in [&first, &second, &third] {
        mark_finished(&context, file.id).await;
    }

    assert_eq!(delete(&app, &alice, first.id).await, StatusCode::NO_CONTENT);
    let trashed_at = row(&context, first.id).await.unwrap().trashed_at;
    assert_eq!(delete(&app, &alice, first.id).await, StatusCode::NO_CONTENT);
    assert_eq!(
        row(&context, first.id).await.unwrap().trashed_at,
        trashed_at
    );

    let (status, _) = post(
        &app,
        &alice,
        "/api/storage/delete-many",
        json!({ "ids": [first.id, second.id] }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        row(&context, second.id).await.unwrap().trash_root_id,
        Some(second.id)
    );

    let (status, body) = post(
        &app,
        &alice,
        "/api/storage/delete-many",
        json!({ "ids": [third.id, Uuid::new_v4()] }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["message"], "forbidden_not_owner");
    assert_eq!(row(&context, third.id).await.unwrap().trashed_at, None);

    let (status, _) = post(
        &app,
        &alice,
        "/api/storage/delete-many",
        json!({ "ids": [] }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

async fn mark_finished(context: &context::Context, id: Uuid) {
    files::Entity::update(files::ActiveModel {
        id: ActiveValue::Unchanged(id),
        chunks_stored: ActiveValue::Set(Some(1)),
        finished_upload_at: ActiveValue::Set(Some(chrono::Utc::now().timestamp())),
        ..Default::default()
    })
    .exec(&context.db)
    .await
    .unwrap();
}

#[actix_web::test]
async fn a_trashed_folder_cannot_be_listed_or_created_into() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");

    let top = folder(&app, &alice, "top", None).await;
    let nested = folder(&app, &alice, "nested", Some(top.id)).await;
    assert_eq!(
        delete(&app, &alice, nested.id).await,
        StatusCode::NO_CONTENT
    );

    let (status, body) = get(&app, &alice, &format!("/api/storage?dir_id={}", nested.id)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["message"], "directory_not_found");

    let (status, body) = get(&app, &alice, &format!("/api/storage?dir_id={}", top.id)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["children"].as_array().unwrap().is_empty());

    let mut payload = make_create_file_for(&alice, &name_tag("inside"));
    payload.file_id = Some(nested.id.to_string());
    let req = test::TestRequest::post()
        .uri("/api/storage")
        .cookie(alice.jwt.clone())
        .set_json(&payload)
        .to_request();
    let (status, body) = send(&app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["message"], format!("file_not_found:{}", nested.id));
}

#[actix_web::test]
async fn restore_reports_a_name_conflict_and_leaves_the_item_in_the_trash() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");

    let original = empty_file(&app, &alice, "report", None).await;
    mark_finished(&context, original.id).await;
    assert_eq!(
        delete(&app, &alice, original.id).await,
        StatusCode::NO_CONTENT
    );
    let _replacement = empty_file(&app, &alice, "report", None).await;

    let (status, body) = post(
        &app,
        &alice,
        "/api/storage/trash/restore",
        json!({ "ids": [original.id] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["restored"], json!([]));
    assert_eq!(body["conflicts"], json!([original.id]));
    assert_eq!(body["missing"], json!([]));
    assert_eq!(
        trash_list(&app, &alice)
            .await
            .into_iter()
            .map(|f| f.id)
            .collect::<Vec<_>>(),
        vec![original.id]
    );

    let (status, _) = post(
        &app,
        &alice,
        "/api/storage/trash/restore",
        json!({ "ids": [] }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[actix_web::test]
async fn a_folder_restored_to_the_root_keeps_its_children() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");

    let parent = folder(&app, &alice, "parent", None).await;
    let moved = folder(&app, &alice, "moved", Some(parent.id)).await;
    let child = folder(&app, &alice, "child", Some(moved.id)).await;

    assert_eq!(delete(&app, &alice, moved.id).await, StatusCode::NO_CONTENT);
    assert_eq!(
        delete(&app, &alice, parent.id).await,
        StatusCode::NO_CONTENT
    );

    let (status, body) = post(
        &app,
        &alice,
        "/api/storage/trash/restore",
        json!({ "ids": [moved.id] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["restored"],
        json!([{ "id": moved.id, "file_id": null, "relocated": true }])
    );

    assert!(root_listing(&app, &alice).await.contains(&moved.id));
    let (status, listing) = get(&app, &alice, &format!("/api/storage?dir_id={}", moved.id)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listing["children"][0]["id"], json!(child.id));
    assert_eq!(
        row(&context, child.id).await.unwrap().file_id,
        Some(moved.id)
    );
}

#[actix_web::test]
async fn delete_forever_and_empty_trash_remove_rows_and_bytes() {
    let context =
        context::Context::mock_with_data_dir(Some("../data/test-trash-purge".to_string())).await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");

    let doomed = upload(&app, &alice, "doomed", None).await;
    let link_id = Uuid::new_v4();
    links::Entity::insert(links::ActiveModel {
        id: ActiveValue::Set(link_id),
        user_id: ActiveValue::Set(alice.user_id),
        file_id: ActiveValue::Set(doomed.id),
        signature: ActiveValue::Set("signature".to_string()),
        downloads: ActiveValue::Set(0),
        encrypted_name: ActiveValue::Set("encrypted-name".to_string()),
        encrypted_link_key: ActiveValue::Set("encrypted-link-key".to_string()),
        encrypted_thumbnail: ActiveValue::Set(None),
        encrypted_file_key: ActiveValue::Set(None),
        created_at: ActiveValue::Set(now_secs()),
        expires_at: ActiveValue::Set(None),
    })
    .exec_without_returning(&context.db)
    .await
    .unwrap();
    file_versions::Entity::insert(file_versions::ActiveModel {
        id: ActiveValue::Set(Uuid::new_v4()),
        file_id: ActiveValue::Set(doomed.id),
        version: ActiveValue::Set(7),
        user_id: ActiveValue::Set(Some(alice.user_id)),
        is_anonymous: ActiveValue::Set(false),
        size: ActiveValue::Set(1),
        chunks: ActiveValue::Set(1),
        sha256: ActiveValue::Set(None),
        created_at: ActiveValue::Set(now_secs()),
    })
    .exec_without_returning(&context.db)
    .await
    .unwrap();
    let survivor = empty_file(&app, &alice, "survivor", None).await;
    mark_finished(&context, survivor.id).await;

    assert_eq!(
        delete(&app, &alice, doomed.id).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        delete(&app, &alice, survivor.id).await,
        StatusCode::NO_CONTENT
    );
    assert!(
        file_tokens::Entity::find()
            .filter(file_tokens::Column::FileId.eq(doomed.id))
            .count(&context.db)
            .await
            .unwrap()
            > 0
    );

    let (status, _) = post(
        &app,
        &alice,
        "/api/storage/trash/purge",
        json!({ "ids": [doomed.id, Uuid::new_v4()] }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(
        trash_list(&app, &alice)
            .await
            .into_iter()
            .map(|f| f.id)
            .collect::<Vec<_>>(),
        vec![survivor.id],
        "a purged item leaves the trash list at once"
    );
    // Nothing about it can be restored any more.
    let (_, body) = post(
        &app,
        &alice,
        "/api/storage/trash/restore",
        json!({ "ids": [doomed.id] }),
    )
    .await;
    assert_eq!(body["missing"], json!([doomed.id]));

    storage::trash::purge_due(&context).await;

    assert!(row(&context, doomed.id).await.is_none());
    assert_eq!(
        user_files::Entity::find()
            .filter(user_files::Column::FileId.eq(doomed.id))
            .count(&context.db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        file_tokens::Entity::find()
            .filter(file_tokens::Column::FileId.eq(doomed.id))
            .count(&context.db)
            .await
            .unwrap(),
        0
    );
    assert!(links::Entity::find_by_id(link_id)
        .one(&context.db)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        file_versions::Entity::find()
            .filter(file_versions::Column::FileId.eq(doomed.id))
            .count(&context.db)
            .await
            .unwrap(),
        0
    );
    assert!(chunks_on_disk(&context, &doomed).await.is_empty());
    assert!(
        row(&context, survivor.id).await.is_some(),
        "only the purged id goes"
    );

    // Purging an unknown id is accepted and changes nothing.
    let (status, _) = post(
        &app,
        &alice,
        "/api/storage/trash/purge",
        json!({ "ids": [Uuid::new_v4()] }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(trash_list(&app, &alice).await.len(), 1);

    let other = upload(&app, &alice, "other", None).await;
    assert_eq!(delete(&app, &alice, other.id).await, StatusCode::NO_CONTENT);
    let (status, _) = post(&app, &alice, "/api/storage/trash/empty", Value::Null).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert!(trash_list(&app, &alice).await.is_empty());
    storage::trash::purge_due(&context).await;
    assert!(row(&context, survivor.id).await.is_none());
    assert!(row(&context, other.id).await.is_none());
    assert!(chunks_on_disk(&context, &other).await.is_empty());

    context.config.app.cleanup();
}

#[actix_web::test]
async fn an_abandoned_upload_skips_the_trash_but_a_zero_byte_file_does_not() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");

    let mut payload = make_create_file_for(&alice, &name_tag("abandoned"));
    payload.chunks = Some(2);
    let abandoned = create(&app, &alice, payload).await;
    assert_eq!(
        delete(&app, &alice, abandoned.id).await,
        StatusCode::NO_CONTENT
    );
    assert!(trash_list(&app, &alice).await.is_empty());
    // The delete already started a purge that may have finished by now.
    assert!(row(&context, abandoned.id)
        .await
        .is_none_or(|row| row.purge_at == Some(0)));
    storage::trash::purge_due(&context).await;
    assert!(row(&context, abandoned.id).await.is_none());

    // Zero-byte files are created with no chunks and never finish.
    let zero = empty_file(&app, &alice, "zero", None).await;
    files::Entity::update(files::ActiveModel {
        id: ActiveValue::Unchanged(zero.id),
        size: ActiveValue::Set(Some(0)),
        chunks: ActiveValue::Set(Some(0)),
        chunks_stored: ActiveValue::Set(Some(0)),
        ..Default::default()
    })
    .exec(&context.db)
    .await
    .unwrap();
    assert_eq!(delete(&app, &alice, zero.id).await, StatusCode::NO_CONTENT);
    let items = trash_list(&app, &alice).await;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, zero.id);
    assert_eq!(
        items[0].purge_at,
        Some(items[0].trashed_at.unwrap() + 30 * DAY)
    );
}

#[actix_web::test]
async fn only_due_items_are_purged_and_a_stale_purge_misses_a_restored_item() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");

    let due = folder(&app, &alice, "due", None).await;
    let inside = folder(&app, &alice, "inside", Some(due.id)).await;
    let kept = folder(&app, &alice, "kept", None).await;
    assert_eq!(delete(&app, &alice, due.id).await, StatusCode::NO_CONTENT);
    assert_eq!(delete(&app, &alice, kept.id).await, StatusCode::NO_CONTENT);

    files::Entity::update_many()
        .set(files::ActiveModel {
            purge_at: ActiveValue::Set(Some(now_secs() - 1)),
            ..Default::default()
        })
        .filter(files::Column::TrashRootId.eq(due.id))
        .exec(&context.db)
        .await
        .unwrap();
    let report = storage::trash::purge_due(&context).await;
    assert_eq!(report.purged, 1);
    assert!(row(&context, due.id).await.is_none());
    assert!(row(&context, inside.id).await.is_none());
    assert!(row(&context, kept.id).await.is_some());

    // A purger holding a stale selection of `kept` finds it restored and
    // trashed again, with a fresh retention, and leaves it alone.
    let (_, body) = post(
        &app,
        &alice,
        "/api/storage/trash/restore",
        json!({ "ids": [kept.id] }),
    )
    .await;
    assert_eq!(body["restored"][0]["id"], json!(kept.id));
    assert_eq!(delete(&app, &alice, kept.id).await, StatusCode::NO_CONTENT);
    assert_eq!(
        storage::trash::purge_root(&context, kept.id).await.unwrap(),
        storage::trash::Outcome::Skipped
    );
    assert_eq!(trash_list(&app, &alice).await[0].id, kept.id);
}

#[actix_web::test]
async fn move_many_checks_its_destination() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let destination = folder(&app, &alice, "destination", None).await;
    let trashed = folder(&app, &alice, "trashed", None).await;
    let source = folder(&app, &alice, "source", None).await;
    let source_child = folder(&app, &alice, "source-child", Some(source.id)).await;
    let not_a_folder = empty_file(&app, &alice, "not-a-folder", None).await;
    let moving = empty_file(&app, &alice, "moving", None).await;
    let trashed_file = empty_file(&app, &alice, "trashed-file", None).await;
    for file in [&not_a_folder, &moving, &trashed_file] {
        mark_finished(&context, file.id).await;
    }
    assert_eq!(
        delete(&app, &alice, trashed.id).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        delete(&app, &alice, trashed_file.id).await,
        StatusCode::NO_CONTENT
    );

    // A folder of bob's that alice can only read.
    let bobs = folder(&app, &bob, "bobs", None).await;
    user_files::Entity::insert(user_files::ActiveModel {
        id: ActiveValue::Set(Uuid::new_v4()),
        file_id: ActiveValue::Set(bobs.id),
        user_id: ActiveValue::Set(alice.user_id),
        encrypted_key: ActiveValue::Set("wrap".to_string()),
        is_owner: ActiveValue::Set(false),
        created_at: ActiveValue::Set(now_secs()),
        expires_at: ActiveValue::Set(None),
        share_role: ActiveValue::Set("reader".to_string()),
        shared_at: ActiveValue::Set(Some(now_secs())),
        shared_by_user_id: ActiveValue::Set(Some(bob.user_id)),
        member_signature: ActiveValue::Set(None),
        member_signed_at: ActiveValue::Set(None),
    })
    .exec_without_returning(&context.db)
    .await
    .unwrap();

    let cases = [
        (
            vec![moving.id],
            trashed.id,
            StatusCode::NOT_FOUND,
            format!("file_not_found:{}", trashed.id),
        ),
        (
            vec![moving.id],
            not_a_folder.id,
            StatusCode::BAD_REQUEST,
            "parent_directory_not_found".to_string(),
        ),
        (
            vec![moving.id],
            bobs.id,
            StatusCode::BAD_REQUEST,
            "parent_directory_not_found".to_string(),
        ),
        (
            vec![source.id],
            source_child.id,
            StatusCode::BAD_REQUEST,
            "cannot_move_to_itself".to_string(),
        ),
        (
            vec![trashed_file.id],
            destination.id,
            StatusCode::NOT_FOUND,
            "file_not_found".to_string(),
        ),
    ];
    for (ids, file_id, status, message) in cases {
        let (got, body) = post(
            &app,
            &alice,
            "/api/storage/move-many",
            json!({ "ids": ids, "file_id": file_id }),
        )
        .await;
        assert_eq!(
            (got, body["message"].as_str()),
            (status, Some(message.as_str()))
        );
    }

    let (status, _) = post(
        &app,
        &alice,
        "/api/storage/move-many",
        json!({ "ids": [moving.id, source.id], "file_id": destination.id }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        row(&context, moving.id).await.unwrap().file_id,
        Some(destination.id)
    );
}

/// Give `user` a non-owner row on `folder_id` at `role`, as a share would.
async fn share_row(context: &context::Context, folder_id: Uuid, user: &TestUser, role: &str) {
    user_files::Entity::insert(user_files::ActiveModel {
        id: ActiveValue::Set(Uuid::new_v4()),
        file_id: ActiveValue::Set(folder_id),
        user_id: ActiveValue::Set(user.user_id),
        encrypted_key: ActiveValue::Set("wrap".to_string()),
        is_owner: ActiveValue::Set(false),
        created_at: ActiveValue::Set(now_secs()),
        expires_at: ActiveValue::Set(None),
        share_role: ActiveValue::Set(role.to_string()),
        shared_at: ActiveValue::Set(Some(now_secs())),
        shared_by_user_id: ActiveValue::Set(None),
        member_signature: ActiveValue::Set(None),
        member_signed_at: ActiveValue::Set(None),
    })
    .exec_without_returning(&context.db)
    .await
    .unwrap();
}

#[actix_web::test]
async fn a_version_fork_checks_its_parent() {
    let context =
        context::Context::mock_with_data_dir(Some("../data/test-trash-fork".to_string())).await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let note = upload(&app, &alice, "note", None).await;
    let trashed = folder(&app, &alice, "trashed", None).await;
    assert_eq!(
        delete(&app, &alice, trashed.id).await,
        StatusCode::NO_CONTENT
    );
    let readable = folder(&app, &bob, "readable", None).await;
    share_row(&context, readable.id, &alice, "reader").await;
    let writable = folder(&app, &bob, "writable", None).await;
    share_row(&context, writable.id, &alice, "editor").await;

    let fork = |parent: Uuid, name: &str| {
        let mut payload = make_create_file_for(&alice, &name_tag(name));
        payload.file_id = Some(parent.to_string());
        serde_json::to_value(&payload).unwrap()
    };
    let uri = format!("/api/storage/{}/versions/1/fork", note.id);

    for (parent, status, message) in [
        (
            trashed.id,
            StatusCode::NOT_FOUND,
            format!("file_not_found:{}", trashed.id),
        ),
        (
            readable.id,
            StatusCode::BAD_REQUEST,
            "parent_directory_not_found".to_string(),
        ),
        (
            note.id,
            StatusCode::BAD_REQUEST,
            "parent_directory_not_found".to_string(),
        ),
    ] {
        let (got, body) = post(&app, &alice, &uri, fork(parent, "refused")).await;
        assert_eq!(
            (got, body["message"].as_str()),
            (status, Some(message.as_str()))
        );
    }

    // A folder shared with the caller as editor takes the copy, as it did
    // before the trash existed.
    let (status, body) = post(&app, &alice, &uri, fork(writable.id, "forked")).await;
    assert_eq!(status, StatusCode::OK, "fork failed: {body}");
    assert_eq!(body["file_id"], json!(writable.id));
    assert!(body["is_owner"].as_bool().unwrap());

    context.config.app.cleanup();
}

/// Wait, without sleeping, for the purge the route started in the
/// background. Every database round trip yields to it.
async fn until_gone(context: &context::Context, id: Uuid) -> bool {
    for _ in 0..10_000 {
        if row(context, id).await.is_none() {
            return true;
        }
        actix_web::rt::task::yield_now().await;
    }
    false
}

#[actix_web::test]
async fn the_routes_purge_in_the_background_on_their_own() {
    let context =
        context::Context::mock_with_data_dir(Some("../data/test-trash-background".to_string()))
            .await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");

    let purged = upload(&app, &alice, "purged", None).await;
    let emptied = upload(&app, &alice, "emptied", None).await;
    assert_eq!(
        delete(&app, &alice, purged.id).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        delete(&app, &alice, emptied.id).await,
        StatusCode::NO_CONTENT
    );

    let (status, _) = post(
        &app,
        &alice,
        "/api/storage/trash/purge",
        json!({ "ids": [purged.id] }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert!(until_gone(&context, purged.id).await, "purge never ran");
    assert!(chunks_on_disk(&context, &purged).await.is_empty());
    assert!(row(&context, emptied.id).await.is_some());

    let (status, _) = post(&app, &alice, "/api/storage/trash/empty", Value::Null).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert!(until_gone(&context, emptied.id).await, "empty never ran");
    assert!(chunks_on_disk(&context, &emptied).await.is_empty());

    // An abandoned upload is purged by the delete itself.
    let mut payload = make_create_file_for(&alice, &name_tag("abandoned"));
    payload.chunks = Some(2);
    let abandoned = create(&app, &alice, payload).await;
    assert_eq!(
        delete(&app, &alice, abandoned.id).await,
        StatusCode::NO_CONTENT
    );
    assert!(
        until_gone(&context, abandoned.id).await,
        "upload purge never ran"
    );

    context.config.app.cleanup();
}

#[actix_web::test]
async fn trashed_bytes_count_toward_used_space_until_purged() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");

    let kept = empty_file(&app, &alice, "kept", None).await;
    let trashed = empty_file(&app, &alice, "trashed", None).await;
    for file in [&kept, &trashed] {
        mark_finished(&context, file.id).await;
    }

    let (_, before) = post(&app, &alice, "/api/storage/stats", Value::Null).await;
    assert_eq!(before["used_space"], 2048);

    assert_eq!(
        delete(&app, &alice, trashed.id).await,
        StatusCode::NO_CONTENT
    );
    let (_, during) = post(&app, &alice, "/api/storage/stats", Value::Null).await;
    assert_eq!(
        during["used_space"], 2048,
        "trash still counts toward quota"
    );

    let (status, _) = post(
        &app,
        &alice,
        "/api/storage/trash/purge",
        json!({ "ids": [trashed.id] }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    storage::trash::purge_due(&context).await;
    let (_, after) = post(&app, &alice, "/api/storage/stats", Value::Null).await;
    assert_eq!(after["used_space"], 1024);
}

#[actix_web::test]
async fn retention_is_validated_advertised_and_only_affects_new_deletes() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");

    let req = test::TestRequest::get()
        .uri("/api/capabilities")
        .to_request();
    let (_, capabilities) = send(&app, req).await;
    assert_eq!(
        capabilities["trash"],
        json!({ "enabled": true, "retention_days": 30 })
    );

    let early = empty_file(&app, &alice, "early", None).await;
    let late = empty_file(&app, &alice, "late", None).await;
    for file in [&early, &late] {
        mark_finished(&context, file.id).await;
    }
    assert_eq!(delete(&app, &alice, early.id).await, StatusCode::NO_CONTENT);
    let early_purge_at = row(&context, early.id).await.unwrap().purge_at;

    for days in [json!(0), json!(-3), json!(5000)] {
        assert_eq!(
            set_retention(&app, &alice, days).await,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(set_retention(&app, &alice, json!(7)).await, StatusCode::OK);

    let req = test::TestRequest::get()
        .uri("/api/capabilities")
        .to_request();
    let (_, capabilities) = send(&app, req).await;
    assert_eq!(capabilities["trash"]["retention_days"], 7);
    assert_eq!(
        row(&context, early.id).await.unwrap().purge_at,
        early_purge_at
    );

    assert_eq!(delete(&app, &alice, late.id).await, StatusCode::NO_CONTENT);
    let late_row = row(&context, late.id).await.unwrap();
    assert_eq!(
        late_row.purge_at,
        Some(late_row.trashed_at.unwrap() + 7 * DAY)
    );

    // A client that predates the setting resets it to the default.
    let (_, mut settings) = get(&app, &alice, "/api/admin/settings").await;
    settings.as_object_mut().unwrap().remove("trash");
    let req = test::TestRequest::put()
        .uri("/api/admin/settings")
        .cookie(alice.jwt.clone())
        .set_json(settings)
        .to_request();
    let (status, body) = send(&app, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["trash"]["retention_days"], 30);
}

#[actix_web::test]
async fn deleting_a_user_purges_their_trash() {
    let context =
        context::Context::mock_with_data_dir(Some("../data/test-trash-user-delete".to_string()))
            .await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, admin, "admin@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let file = upload(&app, &bob, "bobs-file", None).await;
    assert_eq!(delete(&app, &bob, file.id).await, StatusCode::NO_CONTENT);
    assert_eq!(chunks_on_disk(&context, &file).await, vec![0]);

    let req = test::TestRequest::delete()
        .uri(&format!("/api/admin/users/{}", bob.user_id))
        .cookie(admin.jwt.clone())
        .to_request();
    assert_eq!(send(&app, req).await.0, StatusCode::NO_CONTENT);

    assert!(row(&context, file.id).await.is_none());
    assert!(chunks_on_disk(&context, &file).await.is_empty());

    context.config.app.cleanup();
}
