//! Trash meets sharing: a trashed item vanishes for every member and comes
//! back on restore, grants made while part of a folder is in the trash never
//! reach that part, removals always do, and files other members uploaded
//! into a trashed folder go with it.

#[macro_use]
#[path = "./shares_common.rs"]
mod shares_common;

use actix_web::{http::StatusCode, test};
use cryptfns::asn1::{AuditEventActionEnum, ShareRoleEnum};
use entity::{files, links, user_files, ActiveValue, ColumnTrait, EntityTrait, QueryFilter, Uuid};
use fs::prelude::{Fs, FsProviderContract};
use hoodik::server;
use serde_json::{json, Value};

use crate::shares_common::*;

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

async fn restore(app: &impl TestApp, user: &TestUser, id: Uuid) -> Value {
    let (status, body) = post(
        app,
        user,
        "/api/storage/trash/restore",
        json!({ "ids": [id] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    body
}

async fn trash_ids(app: &impl TestApp, user: &TestUser) -> Vec<Uuid> {
    let (status, body) = get(app, user, "/api/storage/trash").await;
    assert_eq!(status, StatusCode::OK);
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().parse().unwrap())
        .collect()
}

async fn listing(app: &impl TestApp, user: &TestUser, dir_id: Uuid) -> Vec<Uuid> {
    let (status, body) = get(app, user, &format!("/api/storage?dir_id={dir_id}")).await;
    assert_eq!(status, StatusCode::OK, "listing failed: {body}");
    body["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().parse().unwrap())
        .collect()
}

/// Mark a created file as fully uploaded, so a delete trashes it instead of
/// purging it as an abandoned upload.
async fn mark_finished(context: &context::Context, id: Uuid) {
    files::Entity::update(files::ActiveModel {
        id: ActiveValue::Unchanged(id),
        chunks_stored: ActiveValue::Set(Some(1)),
        finished_upload_at: ActiveValue::Set(Some(now_secs())),
        ..Default::default()
    })
    .exec(&context.db)
    .await
    .unwrap();
}

async fn has_row(context: &context::Context, file_id: Uuid, user_id: Uuid) -> bool {
    user_files::Entity::find()
        .filter(user_files::Column::FileId.eq(file_id))
        .filter(user_files::Column::UserId.eq(user_id))
        .one(&context.db)
        .await
        .unwrap()
        .is_some()
}

async fn row(context: &context::Context, id: Uuid) -> Option<files::Model> {
    files::Entity::find_by_id(id)
        .one(&context.db)
        .await
        .unwrap()
}

fn roster<'a>(
    owner: &'a TestUser,
    member: &'a TestUser,
    role: ShareRoleEnum,
) -> Vec<FolderListMemberSpec<'a>> {
    vec![
        FolderListMemberSpec {
            user: owner,
            share_role: ShareRoleEnum::CoOwner,
            is_owner: true,
            signed_by: owner,
        },
        FolderListMemberSpec {
            user: member,
            share_role: role,
            is_owner: false,
            signed_by: owner,
        },
    ]
}

fn owner_only(owner: &TestUser) -> Vec<FolderListMemberSpec<'_>> {
    vec![FolderListMemberSpec {
        user: owner,
        share_role: ShareRoleEnum::CoOwner,
        is_owner: true,
        signed_by: owner,
    }]
}

/// Share `folder_id` and the given `entries` (its subtree as the client sees
/// it) from `owner` to `member` at `role`.
async fn share_folder(
    app: &impl TestApp,
    owner: &TestUser,
    member: &TestUser,
    role: ShareRoleEnum,
    folder_id: Uuid,
    entries: &[Uuid],
) -> StatusCode {
    let envelope = build_folder_share_envelope_with_entries(
        owner,
        member,
        role,
        folder_id,
        owner.user_id,
        entries.iter().map(|id| (*id, b"wrap".to_vec())).collect(),
        random_nonce(),
        now_secs(),
        &roster(owner, member, role),
        owner,
    );
    let req = test::TestRequest::post()
        .uri("/api/shares")
        .cookie(owner.jwt.clone())
        .set_json(&envelope)
        .to_request();
    send(app, req).await.0
}

/// `uploader` creates a file of their own inside a folder `owner` shares
/// with them.
async fn upload_into(
    app: &impl TestApp,
    uploader: &TestUser,
    owner: &TestUser,
    folder_id: Uuid,
) -> Uuid {
    let new_file_id = Uuid::new_v4();
    let timestamp = now_secs();
    let event_signature = sign_no_recipient_event(
        uploader,
        new_file_id,
        AuditEventActionEnum::SharedFolderUpload,
        timestamp,
    );
    let body = build_upload_multikey_body(
        new_file_id,
        folder_id,
        &new_file_id.simple().to_string(),
        vec![
            (owner.user_id, "wrap-for-owner", false),
            (uploader.user_id, "wrap-for-uploader", true),
        ],
        timestamp,
        None,
        event_signature,
        timestamp,
    );
    let (status, response) = post(app, uploader, "/api/storage/upload-multikey", body).await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "multikey upload failed: {response}"
    );
    new_file_id
}

#[actix_web::test]
async fn a_trashed_share_vanishes_for_the_recipient_until_restored() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let search_key = storage::mock::file_search_key("shared-note");
    let mut payload = make_create_file_for(&alice, "shared-note");
    payload.search_tokens_file = Some(storage::mock::index_tags(&search_key, "octopus"));
    let req = test::TestRequest::post()
        .uri("/api/storage")
        .cookie(alice.jwt.clone())
        .set_json(&payload)
        .to_request();
    let (_, file) = send(&app, req).await;
    let file_id: Uuid = file["id"].as_str().unwrap().parse().unwrap();
    mark_finished(&context, file_id).await;
    grant!(app, alice, bob, ShareRoleEnum::Reader, file_id);
    let search = json!({ "file_tags": storage::mock::query_tags(&search_key, "octopus") });

    let visible = |mine: &Value, hits: &Value| {
        (
            mine["total"].as_u64().unwrap(),
            mine["items"].as_array().unwrap().len(),
            hits.as_array().unwrap().len(),
        )
    };
    let (_, mine) = get(&app, &bob, "/api/shares/mine").await;
    let (_, hits) = post(&app, &bob, "/api/storage/search", search.clone()).await;
    assert_eq!(visible(&mine, &hits), (1, 1, 1));

    assert_eq!(delete(&app, &alice, file_id).await, StatusCode::NO_CONTENT);

    let (_, mine) = get(&app, &bob, "/api/shares/mine").await;
    let (_, hits) = post(&app, &bob, "/api/storage/search", search.clone()).await;
    assert_eq!(visible(&mine, &hits), (0, 0, 0));
    let (_, mine_by) = get(
        &app,
        &bob,
        &format!("/api/shares/mine/by/{}", alice.user_id),
    )
    .await;
    assert_eq!(mine_by["total"], 0);
    for uri in [
        format!("/api/storage/{file_id}/metadata"),
        format!("/api/storage/{file_id}"),
    ] {
        assert_eq!(
            get(&app, &bob, &uri).await.0,
            StatusCode::NOT_FOUND,
            "{uri}"
        );
    }
    assert!(
        trash_ids(&app, &bob).await.is_empty(),
        "the trash is the owner's"
    );

    assert_eq!(
        restore(&app, &alice, file_id).await["restored"][0]["id"],
        json!(file_id)
    );

    let (_, mine) = get(&app, &bob, "/api/shares/mine").await;
    let (_, hits) = post(&app, &bob, "/api/storage/search", search).await;
    assert_eq!(visible(&mine, &hits), (1, 1, 1));
    assert_eq!(
        get(&app, &bob, &format!("/api/storage/{file_id}/metadata"))
            .await
            .0,
        StatusCode::OK
    );
}

#[actix_web::test]
async fn a_recipient_delete_only_removes_their_view() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let file = create_file!(app, alice, "recipient-delete");
    mark_finished(&context, file.id).await;
    grant!(app, alice, bob, ShareRoleEnum::Editor, file.id);

    assert_eq!(delete(&app, &bob, file.id).await, StatusCode::NO_CONTENT);

    assert!(!has_row(&context, file.id, bob.user_id).await);
    assert_eq!(row(&context, file.id).await.unwrap().trashed_at, None);
    assert!(trash_ids(&app, &alice).await.is_empty());
    assert!(trash_ids(&app, &bob).await.is_empty());
}

#[actix_web::test]
async fn purging_a_folder_takes_the_files_editors_uploaded_into_it() {
    let context =
        context::Context::mock_with_data_dir(Some("../data/test-shares-trash-purge".to_string()))
            .await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let folder = create_folder!(app, alice, "shared-folder");
    assert_eq!(
        share_folder(
            &app,
            &alice,
            &bob,
            ShareRoleEnum::Editor,
            folder.id,
            &[folder.id]
        )
        .await,
        StatusCode::CREATED
    );
    let upload = upload_into(&app, &bob, &alice, folder.id).await;
    let req = test::TestRequest::post()
        .uri(&format!("/api/storage/{upload}?chunk=0"))
        .cookie(bob.jwt.clone())
        .append_header(("Content-Type", "application/octet-stream"))
        .set_payload(b"bob's encrypted bytes".to_vec())
        .to_request();
    assert_eq!(send(&app, req).await.0, StatusCode::OK);
    let upload_row = row(&context, upload).await.unwrap();
    let fs = Fs::new(&context.config);
    assert_eq!(fs.get_uploaded_chunks(&upload_row).await.unwrap(), vec![0]);

    assert_eq!(
        delete(&app, &alice, folder.id).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        row(&context, upload).await.unwrap().trash_root_id,
        Some(folder.id),
        "bob's upload goes to the trash with the folder"
    );
    let (status, _) = post(
        &app,
        &alice,
        "/api/storage/trash/purge",
        json!({ "ids": [folder.id] }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    storage::trash::purge_due(&context).await;

    assert!(row(&context, upload).await.is_none());
    assert!(!has_row(&context, upload, bob.user_id).await);
    assert!(!has_row(&context, upload, alice.user_id).await);
    assert!(
        fs.get_uploaded_chunks(&upload_row)
            .await
            .unwrap()
            .is_empty(),
        "the editor's chunks are not orphaned"
    );

    context.config.app.cleanup();
}

#[actix_web::test]
async fn an_editor_trashes_and_restores_their_own_upload() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let folder = create_folder!(app, alice, "shared-folder");
    assert_eq!(
        share_folder(
            &app,
            &alice,
            &bob,
            ShareRoleEnum::Editor,
            folder.id,
            &[folder.id]
        )
        .await,
        StatusCode::CREATED
    );
    let upload = upload_into(&app, &bob, &alice, folder.id).await;
    mark_finished(&context, upload).await;

    assert_eq!(delete(&app, &bob, upload).await, StatusCode::NO_CONTENT);
    assert_eq!(trash_ids(&app, &bob).await, vec![upload]);
    assert!(trash_ids(&app, &alice).await.is_empty());
    assert!(!listing(&app, &alice, folder.id).await.contains(&upload));

    assert_eq!(
        restore(&app, &bob, upload).await["restored"],
        json!([{ "id": upload, "file_id": folder.id, "relocated": false }])
    );
    assert!(listing(&app, &alice, folder.id).await.contains(&upload));
}

#[actix_web::test]
async fn a_folder_share_skips_a_trashed_descendant() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let folder = create_folder!(app, alice, "shared-folder");
    let active = create_folder!(app, alice, "active-child", folder.id);
    let trashed = create_folder!(app, alice, "trashed-child", folder.id);
    assert_eq!(
        delete(&app, &alice, trashed.id).await,
        StatusCode::NO_CONTENT
    );

    // What a client walking the listing sends: no trashed child.
    assert_eq!(
        share_folder(
            &app,
            &alice,
            &bob,
            ShareRoleEnum::Reader,
            folder.id,
            &[folder.id, active.id]
        )
        .await,
        StatusCode::CREATED
    );
    assert!(has_row(&context, active.id, bob.user_id).await);

    restore(&app, &alice, trashed.id).await;
    assert!(
        !has_row(&context, trashed.id, bob.user_id).await,
        "the grant never reached the trashed child"
    );
}

#[actix_web::test]
async fn revoking_a_folder_share_reaches_a_trashed_descendant() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let folder = create_folder!(app, alice, "shared-folder");
    let child = create_folder!(app, alice, "child", folder.id);
    assert_eq!(
        share_folder(
            &app,
            &alice,
            &bob,
            ShareRoleEnum::Reader,
            folder.id,
            &[folder.id, child.id]
        )
        .await,
        StatusCode::CREATED
    );
    assert_eq!(delete(&app, &alice, child.id).await, StatusCode::NO_CONTENT);

    let body = build_folder_revoke_body(
        &alice,
        &bob,
        folder.id,
        alice.user_id,
        ShareRoleEnum::Reader,
        now_secs(),
        &owner_only(&alice),
        &alice,
    );
    let resp = delete_share!(app, alice, folder.id, bob.user_id, body);
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    assert!(!has_row(&context, folder.id, bob.user_id).await);
    assert!(!has_row(&context, child.id, bob.user_id).await);
}

#[actix_web::test]
async fn moving_into_a_shared_folder_drops_outsiders_from_a_trashed_descendant() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");
    register_user!(app, context, carol, "carol@example.com");

    let destination = create_folder!(app, alice, "destination");
    assert_eq!(
        share_folder(
            &app,
            &alice,
            &bob,
            ShareRoleEnum::Editor,
            destination.id,
            &[destination.id]
        )
        .await,
        StatusCode::CREATED
    );

    let moved = create_folder!(app, alice, "moved");
    let active = create_folder!(app, alice, "moved-active", moved.id);
    let trashed = create_folder!(app, alice, "moved-trashed", moved.id);
    assert_eq!(
        share_folder(
            &app,
            &alice,
            &carol,
            ShareRoleEnum::Reader,
            moved.id,
            &[moved.id, active.id, trashed.id]
        )
        .await,
        StatusCode::CREATED
    );
    assert_eq!(
        delete(&app, &alice, trashed.id).await,
        StatusCode::NO_CONTENT
    );

    let timestamp = now_secs();
    let event_signature = sign_no_recipient_event(
        &alice,
        moved.id,
        AuditEventActionEnum::SharedFolderUpload,
        timestamp,
    );
    let body = build_move_into_shared_cascade_body(
        moved.id,
        destination.id,
        vec![
            (
                moved.id,
                vec![(alice.user_id, "wrap-a"), (bob.user_id, "wrap-b")],
            ),
            (
                active.id,
                vec![(alice.user_id, "wrap-a"), (bob.user_id, "wrap-b")],
            ),
        ],
        timestamp,
        None,
        event_signature,
        timestamp,
    );
    let (status, response) = post(&app, &alice, "/api/storage/move-into-shared", body).await;
    assert_eq!(status, StatusCode::OK, "move failed: {response}");

    for id in [moved.id, active.id, trashed.id] {
        assert!(
            !has_row(&context, id, carol.user_id).await,
            "carol keeps nothing"
        );
    }
    assert!(has_row(&context, active.id, bob.user_id).await);
    assert!(
        !has_row(&context, trashed.id, bob.user_id).await,
        "bob gets nothing on the trashed node"
    );
}

#[actix_web::test]
async fn revoking_a_co_owner_reroots_their_upload_out_of_a_trashed_folder() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let folder = create_folder!(app, alice, "shared-folder");
    let sub = create_folder!(app, alice, "sub", folder.id);
    assert_eq!(
        share_folder(
            &app,
            &alice,
            &bob,
            ShareRoleEnum::CoOwner,
            folder.id,
            &[folder.id, sub.id]
        )
        .await,
        StatusCode::CREATED
    );
    let upload = upload_into(&app, &bob, &alice, sub.id).await;
    mark_finished(&context, upload).await;

    assert_eq!(delete(&app, &alice, sub.id).await, StatusCode::NO_CONTENT);
    assert_eq!(
        row(&context, upload).await.unwrap().trash_root_id,
        Some(sub.id)
    );

    let body = build_folder_revoke_body(
        &alice,
        &bob,
        folder.id,
        alice.user_id,
        ShareRoleEnum::CoOwner,
        now_secs(),
        &owner_only(&alice),
        &alice,
    );
    let resp = delete_share!(app, alice, folder.id, bob.user_id, body);
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    let moved = row(&context, upload).await.unwrap();
    assert_eq!(moved.file_id, None);
    assert_eq!(moved.trash_root_id, Some(upload), "its own trash group now");
    assert_eq!(trash_ids(&app, &bob).await, vec![upload]);

    let (status, _) = post(
        &app,
        &alice,
        "/api/storage/trash/purge",
        json!({ "ids": [sub.id] }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    storage::trash::purge_due(&context).await;

    assert!(row(&context, sub.id).await.is_none());
    assert!(row(&context, upload).await.is_some(), "bob's file survives");
    assert_eq!(
        restore(&app, &bob, upload).await["restored"],
        json!([{ "id": upload, "file_id": null, "relocated": false }])
    );
}

#[actix_web::test]
async fn move_out_and_evict_refuse_a_trashed_file() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let folder = create_folder!(app, alice, "shared-folder");
    assert_eq!(
        share_folder(
            &app,
            &alice,
            &bob,
            ShareRoleEnum::Editor,
            folder.id,
            &[folder.id]
        )
        .await,
        StatusCode::CREATED
    );

    let bobs = upload_into(&app, &bob, &alice, folder.id).await;
    mark_finished(&context, bobs).await;
    assert_eq!(delete(&app, &bob, bobs).await, StatusCode::NO_CONTENT);
    let timestamp = now_secs();
    let (status, body) = post(
        &app,
        &alice,
        &format!("/api/storage/{bobs}/evict-from-folder"),
        build_evict_body(&alice, &bob, bobs, timestamp),
    )
    .await;
    assert_eq!(
        (status, body["message"].as_str()),
        (StatusCode::NOT_FOUND, Some("file_not_found"))
    );

    let alices = upload_into(&app, &alice, &bob, folder.id).await;
    mark_finished(&context, alices).await;
    assert_eq!(delete(&app, &alice, alices).await, StatusCode::NO_CONTENT);
    let timestamp = now_secs();
    let event_signature = sign_no_recipient_event(
        &alice,
        alices,
        AuditEventActionEnum::SharedFolderMoveOut,
        timestamp,
    );
    let (status, body) = post(
        &app,
        &alice,
        "/api/storage/move-out-of-shared",
        build_move_out_of_shared_body(alices, None, event_signature, timestamp),
    )
    .await;
    assert_eq!(
        (status, body["message"].as_str()),
        (StatusCode::NOT_FOUND, Some("file_not_found"))
    );
}

async fn link_count(app: &impl TestApp, owner: &TestUser) -> usize {
    let (status, body) = get(app, owner, "/api/links").await;
    assert_eq!(status, StatusCode::OK);
    body.as_array().unwrap().len()
}

#[actix_web::test]
async fn a_public_link_to_a_trashed_file_answers_not_found() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");

    let file = create_file!(app, alice, "linked");
    mark_finished(&context, file.id).await;
    let link_id = Uuid::new_v4();
    links::Entity::insert(links::ActiveModel {
        id: ActiveValue::Set(link_id),
        user_id: ActiveValue::Set(alice.user_id),
        file_id: ActiveValue::Set(file.id),
        signature: ActiveValue::Set("signature".to_string()),
        downloads: ActiveValue::Set(0),
        encrypted_name: ActiveValue::Set("encrypted-name".to_string()),
        encrypted_link_key: ActiveValue::Set("encrypted-link-key".to_string()),
        encrypted_thumbnail: ActiveValue::Set(None),
        encrypted_file_key: ActiveValue::Set(Some("encrypted-file-key".to_string())),
        created_at: ActiveValue::Set(now_secs()),
        expires_at: ActiveValue::Set(None),
    })
    .exec_without_returning(&context.db)
    .await
    .unwrap();

    let public_metadata = || {
        test::TestRequest::get()
            .uri(&format!("/api/links/{link_id}/metadata"))
            .to_request()
    };
    assert_eq!(send(&app, public_metadata()).await.0, StatusCode::OK);
    assert_eq!(link_count(&app, &alice).await, 1);

    assert_eq!(delete(&app, &alice, file.id).await, StatusCode::NO_CONTENT);
    let (status, body) = send(&app, public_metadata()).await;
    assert_eq!(
        (status, body["message"].as_str()),
        (StatusCode::NOT_FOUND, Some("link"))
    );
    let req = test::TestRequest::post()
        .uri(&format!("/api/links/{link_id}"))
        .to_request();
    assert_eq!(send(&app, req).await.0, StatusCode::NOT_FOUND);
    assert_eq!(link_count(&app, &alice).await, 0);

    restore(&app, &alice, file.id).await;
    assert_eq!(send(&app, public_metadata()).await.0, StatusCode::OK);
    assert_eq!(link_count(&app, &alice).await, 1);
}

async fn role_of(context: &context::Context, file_id: Uuid, user_id: Uuid) -> Option<String> {
    user_files::Entity::find()
        .filter(user_files::Column::FileId.eq(file_id))
        .filter(user_files::Column::UserId.eq(user_id))
        .one(&context.db)
        .await
        .unwrap()
        .map(|row| row.share_role)
}

/// Change `member`'s role on `folder_id` the way a client does: entries for
/// the folder only, which is its whole subtree while its children are in the
/// trash or absent.
async fn change_folder_role(
    app: &impl TestApp,
    owner: &TestUser,
    member: &TestUser,
    folder_id: Uuid,
    before: ShareRoleEnum,
    after: ShareRoleEnum,
) {
    let envelope = build_folder_role_change_envelope(
        owner,
        member,
        before,
        after,
        folder_id,
        owner.user_id,
        random_nonce(),
        now_secs(),
        &roster(owner, member, after),
        owner,
    );
    let (status, body) = post(app, owner, "/api/shares", envelope).await;
    assert_eq!(status, StatusCode::CREATED, "role change failed: {body}");
}

#[actix_web::test]
async fn a_role_change_reaches_a_trashed_descendant() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let folder = create_folder!(app, alice, "shared-folder");
    let child = create_folder!(app, alice, "child", folder.id);
    assert_eq!(
        share_folder(
            &app,
            &alice,
            &bob,
            ShareRoleEnum::CoOwner,
            folder.id,
            &[folder.id, child.id]
        )
        .await,
        StatusCode::CREATED
    );
    assert_eq!(delete(&app, &alice, child.id).await, StatusCode::NO_CONTENT);

    change_folder_role(
        &app,
        &alice,
        &bob,
        folder.id,
        ShareRoleEnum::CoOwner,
        ShareRoleEnum::Reader,
    )
    .await;
    restore(&app, &alice, child.id).await;

    assert_eq!(
        role_of(&context, folder.id, bob.user_id).await.as_deref(),
        Some("reader")
    );
    assert_eq!(
        role_of(&context, child.id, bob.user_id).await.as_deref(),
        Some("reader"),
        "the demotion reached the restored child"
    );
}

#[actix_web::test]
async fn moving_into_a_shared_folder_rebinds_roles_on_a_trashed_descendant() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let destination = create_folder!(app, alice, "destination");
    assert_eq!(
        share_folder(
            &app,
            &alice,
            &bob,
            ShareRoleEnum::Reader,
            destination.id,
            &[destination.id]
        )
        .await,
        StatusCode::CREATED
    );
    let moved = create_folder!(app, alice, "moved");
    let active = create_folder!(app, alice, "moved-active", moved.id);
    let trashed = create_folder!(app, alice, "moved-trashed", moved.id);
    assert_eq!(
        share_folder(
            &app,
            &alice,
            &bob,
            ShareRoleEnum::Editor,
            moved.id,
            &[moved.id, active.id, trashed.id]
        )
        .await,
        StatusCode::CREATED
    );
    assert_eq!(
        delete(&app, &alice, trashed.id).await,
        StatusCode::NO_CONTENT
    );

    let timestamp = now_secs();
    let event_signature = sign_no_recipient_event(
        &alice,
        moved.id,
        AuditEventActionEnum::SharedFolderUpload,
        timestamp,
    );
    let keys = vec![(alice.user_id, "wrap-a"), (bob.user_id, "wrap-b")];
    let body = build_move_into_shared_cascade_body(
        moved.id,
        destination.id,
        vec![(moved.id, keys.clone()), (active.id, keys)],
        timestamp,
        None,
        event_signature,
        timestamp,
    );
    let (status, response) = post(&app, &alice, "/api/storage/move-into-shared", body).await;
    assert_eq!(status, StatusCode::OK, "move failed: {response}");

    restore(&app, &alice, trashed.id).await;
    for id in [moved.id, active.id, trashed.id] {
        assert_eq!(
            role_of(&context, id, bob.user_id).await.as_deref(),
            Some("reader"),
            "bob only reads inside the destination"
        );
    }
}

#[actix_web::test]
async fn a_restore_into_a_folder_the_caller_can_only_read_goes_to_the_root() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let folder = create_folder!(app, alice, "shared-folder");
    assert_eq!(
        share_folder(
            &app,
            &alice,
            &bob,
            ShareRoleEnum::Editor,
            folder.id,
            &[folder.id]
        )
        .await,
        StatusCode::CREATED
    );
    let upload = upload_into(&app, &bob, &alice, folder.id).await;
    mark_finished(&context, upload).await;
    assert_eq!(delete(&app, &bob, upload).await, StatusCode::NO_CONTENT);

    change_folder_role(
        &app,
        &alice,
        &bob,
        folder.id,
        ShareRoleEnum::Editor,
        ShareRoleEnum::Reader,
    )
    .await;

    assert_eq!(
        restore(&app, &bob, upload).await["restored"],
        json!([{ "id": upload, "file_id": null, "relocated": true }])
    );
    assert_eq!(row(&context, upload).await.unwrap().file_id, None);
    assert!(
        user_files::Entity::find()
            .filter(user_files::Column::FileId.eq(upload))
            .filter(user_files::Column::UserId.eq(bob.user_id))
            .one(&context.db)
            .await
            .unwrap()
            .unwrap()
            .is_owner,
        "the role change left bob's own row alone"
    );
}

#[actix_web::test]
async fn a_trashed_child_of_a_shared_folder_vanishes_for_the_recipient() {
    let context = context::Context::mock_sqlite().await;
    let app = test::init_service(server::app(context.clone())).await;
    register_user!(app, context, alice, "alice@example.com");
    register_user!(app, context, bob, "bob@example.com");

    let folder = create_folder!(app, alice, "shared-folder");
    let search_key = storage::mock::file_search_key("child-note");
    let mut payload = make_create_child_file(&alice, "child-note", folder.id);
    payload.search_tokens_file = Some(storage::mock::index_tags(&search_key, "octopus"));
    let req = test::TestRequest::post()
        .uri("/api/storage")
        .cookie(alice.jwt.clone())
        .set_json(&payload)
        .to_request();
    let (_, child) = send(&app, req).await;
    let child_id: Uuid = child["id"].as_str().unwrap().parse().unwrap();
    mark_finished(&context, child_id).await;
    assert_eq!(
        share_folder(
            &app,
            &alice,
            &bob,
            ShareRoleEnum::Reader,
            folder.id,
            &[folder.id, child_id]
        )
        .await,
        StatusCode::CREATED
    );
    let search = json!({ "file_tags": storage::mock::query_tags(&search_key, "octopus") });

    let seen = |listing: &[Uuid], hits: &Value| {
        (listing.contains(&child_id), hits.as_array().unwrap().len())
    };
    let (_, hits) = post(&app, &bob, "/api/storage/search", search.clone()).await;
    assert_eq!(
        seen(&listing(&app, &bob, folder.id).await, &hits),
        (true, 1)
    );

    assert_eq!(delete(&app, &alice, child_id).await, StatusCode::NO_CONTENT);
    let (_, hits) = post(&app, &bob, "/api/storage/search", search.clone()).await;
    assert_eq!(
        seen(&listing(&app, &bob, folder.id).await, &hits),
        (false, 0)
    );
    for uri in [
        format!("/api/storage/{child_id}/metadata"),
        format!("/api/storage/{child_id}"),
    ] {
        assert_eq!(
            get(&app, &bob, &uri).await.0,
            StatusCode::NOT_FOUND,
            "{uri}"
        );
    }

    restore(&app, &alice, child_id).await;
    let (_, hits) = post(&app, &bob, "/api/storage/search", search).await;
    assert_eq!(
        seen(&listing(&app, &bob, folder.id).await, &hits),
        (true, 1)
    );
    assert_eq!(
        get(&app, &bob, &format!("/api/storage/{child_id}/metadata"))
            .await
            .0,
        StatusCode::OK
    );
}
