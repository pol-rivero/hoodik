use std::sync::atomic::{AtomicUsize, Ordering};

use chrono::Utc;
use context::Context;
use entity::{files, ActiveValue, ColumnTrait, EntityTrait, QueryFilter, Uuid};
use error::{AppResult, Error};

use crate::{
    data::{app_file::AppFile, trash::Restored},
    mock::create_file,
    repository::Repository,
    trash::{purge_due_with, purge_root_with, ChunkStore, Outcome},
};

const DAY: i64 = 86_400;

/// Records what it was asked to delete and fails for the ids it is told to.
#[derive(Default)]
struct TestStore {
    fail_for: Vec<Uuid>,
    purged: AtomicUsize,
}

impl ChunkStore for TestStore {
    async fn purge_file(&self, file: &files::Model) -> AppResult<()> {
        if self.fail_for.contains(&file.id) {
            return Err(Error::InternalError("storage_unavailable".to_string()));
        }
        self.purged.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

async fn row(context: &Context, id: Uuid) -> Option<files::Model> {
    files::Entity::find_by_id(id)
        .one(&context.db)
        .await
        .unwrap()
}

async fn dir(
    context: &Context,
    user: &entity::users::Model,
    name: &str,
    parent: Option<Uuid>,
) -> AppFile {
    create_file(context, user, name, parent, Some("dir"))
        .await
        .unwrap()
}

async fn file(
    context: &Context,
    user: &entity::users::Model,
    name: &str,
    parent: Option<Uuid>,
) -> AppFile {
    create_file(context, user, name, parent, Some("text/plain"))
        .await
        .unwrap()
}

async fn trash(context: &Context, user_id: Uuid, id: Uuid, at: i64) {
    Repository::new(&context.db)
        .trash(user_id)
        .trash(id, at, at + 30 * DAY)
        .await
        .unwrap();
}

async fn set_purge_at(context: &Context, root: Uuid, purge_at: i64) {
    files::Entity::update_many()
        .set(files::ActiveModel {
            purge_at: ActiveValue::Set(Some(purge_at)),
            ..Default::default()
        })
        .filter(files::Column::TrashRootId.eq(root))
        .exec(&context.db)
        .await
        .unwrap();
}

#[actix_web::test]
async fn trashing_a_folder_stamps_its_whole_subtree() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let now = Utc::now().timestamp();

    let top = dir(&context, &user, "top", None).await;
    let inner = dir(&context, &user, "inner", Some(top.id)).await;
    let leaf = file(&context, &user, "leaf", Some(inner.id)).await;
    let outside = file(&context, &user, "outside", None).await;

    let stamped = Repository::new(&context.db)
        .trash(user.id)
        .trash(top.id, now, now + 30 * DAY)
        .await
        .unwrap();
    assert_eq!(stamped, 3);

    for id in [top.id, inner.id, leaf.id] {
        let row = row(&context, id).await.unwrap();
        assert_eq!(row.trashed_at, Some(now));
        assert_eq!(row.trash_root_id, Some(top.id));
        assert_eq!(row.purge_at, Some(now + 30 * DAY));
    }
    // Parent pointers are untouched.
    assert_eq!(
        row(&context, leaf.id).await.unwrap().file_id,
        Some(inner.id)
    );
    assert_eq!(row(&context, outside.id).await.unwrap().trashed_at, None);
}

#[actix_web::test]
async fn a_separately_trashed_child_keeps_its_group() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let now = Utc::now().timestamp();

    let parent = dir(&context, &user, "parent", None).await;
    let child = dir(&context, &user, "child", Some(parent.id)).await;
    let grandchild = file(&context, &user, "grandchild", Some(child.id)).await;

    trash(&context, user.id, child.id, now - 10).await;
    trash(&context, user.id, parent.id, now).await;

    for id in [child.id, grandchild.id] {
        let row = row(&context, id).await.unwrap();
        assert_eq!(row.trash_root_id, Some(child.id));
        assert_eq!(row.trashed_at, Some(now - 10));
    }
    assert_eq!(
        row(&context, parent.id).await.unwrap().trash_root_id,
        Some(parent.id)
    );
}

#[actix_web::test]
async fn a_folder_and_its_child_in_one_batch_make_one_root() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;

    let parent = dir(&context, &user, "parent", None).await;
    let child = file(&context, &user, "child", Some(parent.id)).await;
    let other = file(&context, &user, "other", None).await;

    let repository = Repository::new(&context.db);
    let trash = repository.trash(user.id);
    assert_eq!(
        trash
            .roots(&[child.id, parent.id, other.id, parent.id])
            .await
            .unwrap(),
        vec![parent.id, other.id]
    );
    assert_eq!(
        trash.roots(&[parent.id, child.id]).await.unwrap(),
        vec![parent.id]
    );
}

#[actix_web::test]
async fn the_list_holds_restorable_roots_of_the_owner_only() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let other = entity::mock::create_user(&context.db, "second@test.com", None).await;
    let now = Utc::now().timestamp();

    let folder = dir(&context, &user, "folder", None).await;
    let _inside = file(&context, &user, "inside", Some(folder.id)).await;
    let older = file(&context, &user, "older", None).await;
    let due = file(&context, &user, "due", None).await;
    let theirs = file(&context, &other, "theirs", None).await;

    trash(&context, user.id, older.id, now - 20).await;
    trash(&context, user.id, folder.id, now - 10).await;
    trash(&context, user.id, due.id, now - 5).await;
    set_purge_at(&context, due.id, now - 1).await;
    trash(&context, other.id, theirs.id, now).await;

    let repository = Repository::new(&context.db);
    let listed: Vec<Uuid> = repository
        .trash(user.id)
        .list(true, now)
        .await
        .unwrap()
        .into_iter()
        .map(|f| f.id)
        .collect();
    assert_eq!(listed, vec![folder.id, older.id]);

    let theirs_listed: Vec<Uuid> = repository
        .trash(other.id)
        .list(false, now)
        .await
        .unwrap()
        .into_iter()
        .map(|f| f.id)
        .collect();
    assert_eq!(theirs_listed, vec![theirs.id]);
}

#[actix_web::test]
async fn restoring_a_folder_leaves_a_separately_trashed_child_in_the_trash() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let now = Utc::now().timestamp();

    let parent = dir(&context, &user, "parent", None).await;
    let kept = file(&context, &user, "kept", Some(parent.id)).await;
    let child = file(&context, &user, "child", Some(parent.id)).await;

    trash(&context, user.id, child.id, now - 10).await;
    trash(&context, user.id, parent.id, now - 5).await;

    let response = Repository::new(&context.db)
        .trash(user.id)
        .restore(&[parent.id], now)
        .await
        .unwrap();
    assert_eq!(
        response.restored,
        vec![Restored {
            id: parent.id,
            file_id: None,
            relocated: false
        }]
    );

    assert_eq!(row(&context, parent.id).await.unwrap().trashed_at, None);
    assert_eq!(row(&context, kept.id).await.unwrap().trashed_at, None);
    assert_eq!(
        row(&context, child.id).await.unwrap().trash_root_id,
        Some(child.id)
    );
}

#[actix_web::test]
async fn a_relocated_folder_keeps_its_tree() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let now = Utc::now().timestamp();

    let parent = dir(&context, &user, "parent", None).await;
    let folder = dir(&context, &user, "folder", Some(parent.id)).await;
    let nested = dir(&context, &user, "nested", Some(folder.id)).await;
    let leaf = file(&context, &user, "leaf", Some(nested.id)).await;

    trash(&context, user.id, folder.id, now - 10).await;
    trash(&context, user.id, parent.id, now - 5).await;

    let response = Repository::new(&context.db)
        .trash(user.id)
        .restore(&[folder.id], now)
        .await
        .unwrap();
    assert_eq!(
        response.restored,
        vec![Restored {
            id: folder.id,
            file_id: None,
            relocated: true
        }]
    );

    assert_eq!(row(&context, folder.id).await.unwrap().file_id, None);
    assert_eq!(
        row(&context, nested.id).await.unwrap().file_id,
        Some(folder.id)
    );
    assert_eq!(
        row(&context, leaf.id).await.unwrap().file_id,
        Some(nested.id)
    );
    assert_eq!(row(&context, leaf.id).await.unwrap().trashed_at, None);
    assert_eq!(
        row(&context, parent.id).await.unwrap().trash_root_id,
        Some(parent.id)
    );
}

#[actix_web::test]
async fn a_child_and_its_parent_restore_in_place_whatever_the_request_order() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let now = Utc::now().timestamp();

    let parent = dir(&context, &user, "parent", None).await;
    let child = file(&context, &user, "child", Some(parent.id)).await;

    trash(&context, user.id, child.id, now - 10).await;
    trash(&context, user.id, parent.id, now - 5).await;

    let response = Repository::new(&context.db)
        .trash(user.id)
        .restore(&[child.id, parent.id], now)
        .await
        .unwrap();
    assert_eq!(
        response.restored,
        vec![
            Restored {
                id: parent.id,
                file_id: None,
                relocated: false
            },
            Restored {
                id: child.id,
                file_id: Some(parent.id),
                relocated: false
            },
        ]
    );
    assert!(response.conflicts.is_empty());
    assert!(response.missing.is_empty());
}

#[actix_web::test]
async fn restore_reports_name_conflicts() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let now = Utc::now().timestamp();

    // Against an active sibling.
    let first = file(&context, &user, "same", None).await;
    trash(&context, user.id, first.id, now - 10).await;
    let replacement = file(&context, &user, "same", None).await;

    let response = Repository::new(&context.db)
        .trash(user.id)
        .restore(&[first.id], now)
        .await
        .unwrap();
    assert_eq!(response.conflicts, vec![first.id]);
    assert!(response.restored.is_empty());
    assert_eq!(
        row(&context, first.id).await.unwrap().trash_root_id,
        Some(first.id)
    );

    // Within one batch: the newest comes back, the other collides with it.
    trash(&context, user.id, replacement.id, now - 5).await;
    let response = Repository::new(&context.db)
        .trash(user.id)
        .restore(&[first.id, replacement.id], now)
        .await
        .unwrap();
    assert_eq!(
        response.restored.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![replacement.id]
    );
    assert_eq!(response.conflicts, vec![first.id]);
}

#[actix_web::test]
async fn restore_after_a_claim_reports_missing() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let other = entity::mock::create_user(&context.db, "second@test.com", None).await;
    let now = Utc::now().timestamp();

    let claimed = file(&context, &user, "claimed", None).await;
    let folder = dir(&context, &user, "folder", None).await;
    let inside = file(&context, &user, "inside", Some(folder.id)).await;
    let active = file(&context, &user, "active", None).await;
    let theirs = file(&context, &other, "theirs", None).await;

    trash(&context, user.id, claimed.id, now - 10).await;
    set_purge_at(&context, claimed.id, 0).await;
    trash(&context, user.id, folder.id, now - 10).await;
    trash(&context, other.id, theirs.id, now - 10).await;

    let unknown = Uuid::new_v4();
    let response = Repository::new(&context.db)
        .trash(user.id)
        .restore(&[claimed.id, inside.id, active.id, theirs.id, unknown], now)
        .await
        .unwrap();
    assert!(response.restored.is_empty());
    assert_eq!(
        response.missing,
        vec![claimed.id, inside.id, active.id, theirs.id, unknown]
    );
    assert_eq!(row(&context, claimed.id).await.unwrap().purge_at, Some(0));
}

#[actix_web::test]
async fn purging_a_folder_detaches_a_nested_trash_item_which_survives() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let now = Utc::now().timestamp();

    let parent = dir(&context, &user, "parent", None).await;
    let leaf = file(&context, &user, "leaf", Some(parent.id)).await;
    let nested = dir(&context, &user, "nested", Some(parent.id)).await;
    let nested_leaf = file(&context, &user, "nested-leaf", Some(nested.id)).await;

    trash(&context, user.id, nested.id, now - 10).await;
    trash(&context, user.id, parent.id, now - 5).await;
    set_purge_at(&context, parent.id, now - 1).await;

    let store = TestStore::default();
    assert_eq!(
        purge_root_with(&context, &store, parent.id).await.unwrap(),
        Outcome::Purged
    );
    assert_eq!(
        store.purged.load(Ordering::SeqCst),
        1,
        "only the leaf has chunks"
    );

    assert!(row(&context, parent.id).await.is_none());
    assert!(row(&context, leaf.id).await.is_none());
    let nested_row = row(&context, nested.id).await.unwrap();
    assert_eq!(nested_row.file_id, None);
    assert_eq!(nested_row.trash_root_id, Some(nested.id));
    assert_eq!(
        row(&context, nested_leaf.id).await.unwrap().file_id,
        Some(nested.id)
    );

    // Purging something that is not due, or already gone, does nothing.
    assert_eq!(
        purge_root_with(&context, &store, nested.id).await.unwrap(),
        Outcome::Skipped
    );
    assert_eq!(
        purge_root_with(&context, &store, parent.id).await.unwrap(),
        Outcome::Skipped
    );
}

#[actix_web::test]
async fn a_storage_failure_leaves_the_group_claimed_for_the_next_pass() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let now = Utc::now().timestamp();

    let doomed = file(&context, &user, "doomed", None).await;
    trash(&context, user.id, doomed.id, now - 10).await;
    set_purge_at(&context, doomed.id, now - 1).await;

    let failing = TestStore {
        fail_for: vec![doomed.id],
        ..Default::default()
    };
    assert!(purge_root_with(&context, &failing, doomed.id)
        .await
        .is_err());

    let row_after = row(&context, doomed.id).await.unwrap();
    assert_eq!(row_after.purge_at, Some(0));

    // Claimed means no longer restorable.
    let response = Repository::new(&context.db)
        .trash(user.id)
        .restore(&[doomed.id], now)
        .await
        .unwrap();
    assert_eq!(response.missing, vec![doomed.id]);

    let working = TestStore::default();
    assert_eq!(
        purge_root_with(&context, &working, doomed.id)
            .await
            .unwrap(),
        Outcome::Purged
    );
    assert!(row(&context, doomed.id).await.is_none());
}

#[actix_web::test]
async fn a_pass_with_a_failing_group_still_purges_the_others() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let now = Utc::now().timestamp();

    let broken = file(&context, &user, "broken", None).await;
    let fine = file(&context, &user, "fine", None).await;
    let not_due = file(&context, &user, "not-due", None).await;
    for item in [&broken, &fine, &not_due] {
        trash(&context, user.id, item.id, now - 10).await;
    }
    set_purge_at(&context, broken.id, now - 1).await;
    set_purge_at(&context, fine.id, 0).await;

    let store = TestStore {
        fail_for: vec![broken.id],
        ..Default::default()
    };
    let report = purge_due_with(&context, &store).await;
    assert_eq!(report.purged, 1);
    assert_eq!(report.failed, 1);

    assert!(row(&context, fine.id).await.is_none());
    assert_eq!(row(&context, broken.id).await.unwrap().purge_at, Some(0));
    assert!(row(&context, not_due.id).await.unwrap().purge_at.unwrap() > now);
}

#[actix_web::test]
async fn reroot_only_moves_a_relocated_member_of_a_live_group() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let now = Utc::now().timestamp();

    let active = file(&context, &user, "active", None).await;
    entity::trash::reroot_if_trashed(&context.db, active.id, now)
        .await
        .unwrap();
    assert_eq!(row(&context, active.id).await.unwrap().trash_root_id, None);

    let parent = dir(&context, &user, "parent", None).await;
    let moved = dir(&context, &user, "moved", Some(parent.id)).await;
    let moved_leaf = file(&context, &user, "moved-leaf", Some(moved.id)).await;
    let stays = file(&context, &user, "stays", Some(parent.id)).await;
    trash(&context, user.id, parent.id, now - 10).await;

    // A root is already its own group.
    entity::trash::reroot_if_trashed(&context.db, parent.id, now)
        .await
        .unwrap();
    assert_eq!(
        row(&context, parent.id).await.unwrap().trash_root_id,
        Some(parent.id)
    );

    entity::trash::reroot_if_trashed(&context.db, moved.id, now)
        .await
        .unwrap();
    assert_eq!(
        row(&context, moved.id).await.unwrap().trash_root_id,
        Some(moved.id)
    );
    assert_eq!(
        row(&context, moved_leaf.id).await.unwrap().trash_root_id,
        Some(moved.id)
    );
    assert_eq!(
        row(&context, stays.id).await.unwrap().trash_root_id,
        Some(parent.id)
    );

    // A due group is about to be deleted and is left as it is.
    let due_parent = dir(&context, &user, "due-parent", None).await;
    let due_child = file(&context, &user, "due-child", Some(due_parent.id)).await;
    trash(&context, user.id, due_parent.id, now - 10).await;
    set_purge_at(&context, due_parent.id, 0).await;
    entity::trash::reroot_if_trashed(&context.db, due_child.id, now)
        .await
        .unwrap();
    assert_eq!(
        row(&context, due_child.id).await.unwrap().trash_root_id,
        Some(due_parent.id)
    );
}

#[actix_web::test]
async fn ancestors_restore_first_when_trashed_in_the_same_second() {
    let context = Context::mock_sqlite().await;
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let now = Utc::now().timestamp();

    // Only an id order that puts the child first can go wrong, and ids are
    // random: draw until the child sorts before both of its ancestors.
    for attempt in 0..256 {
        let top = dir(&context, &user, &format!("top-{attempt}"), None).await;
        let middle = dir(&context, &user, &format!("middle-{attempt}"), Some(top.id)).await;
        let child = dir(
            &context,
            &user,
            &format!("child-{attempt}"),
            Some(middle.id),
        )
        .await;
        if child.id > top.id || child.id > middle.id {
            continue;
        }

        trash(&context, user.id, child.id, now).await;
        trash(&context, user.id, middle.id, now).await;
        trash(&context, user.id, top.id, now).await;

        let response = Repository::new(&context.db)
            .trash(user.id)
            .restore(&[child.id, middle.id, top.id], now)
            .await
            .unwrap();
        let by_id = |id: Uuid| {
            response
                .restored
                .iter()
                .find(|r| r.id == id)
                .cloned()
                .unwrap()
        };
        assert_eq!(by_id(child.id).file_id, Some(middle.id));
        assert!(!by_id(child.id).relocated);
        assert_eq!(by_id(middle.id).file_id, Some(top.id));
        assert!(!by_id(middle.id).relocated);
        assert_eq!(
            row(&context, child.id).await.unwrap().file_id,
            Some(middle.id)
        );
        return;
    }
    panic!("never drew a child id below both ancestors");
}
