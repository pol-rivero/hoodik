//! Purging the trash: deleting trashed groups for good, both on demand and
//! from the hourly background pass.
//!
//! Every step tolerates being interrupted and re-run, and nothing here may
//! panic: the binary exits the whole process on a panic in any thread.

use std::{sync::Arc, time::Duration};

use chrono::Utc;
use context::Context;
use entity::{
    files, ActiveValue, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect,
    Statement, TransactionTrait, Uuid,
};
use error::AppResult;
use fs::prelude::*;

use crate::repository::cached;

const PURGE_INTERVAL: Duration = Duration::from_secs(3600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Purged,
    /// Nothing to do: the group was restored, is already gone, or is not due.
    Skipped,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PurgeReport {
    pub purged: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// Where the chunks of a purged file are deleted. A seam so tests can stand
/// in a store that fails.
pub(crate) trait ChunkStore {
    async fn purge_file(&self, file: &files::Model) -> AppResult<()>;
}

impl ChunkStore for Fs<'_> {
    async fn purge_file(&self, file: &files::Model) -> AppResult<()> {
        self.purge_all(file).await
    }
}

/// Purge everything that is due, one group at a time. A group that fails is
/// logged and left for the next pass; the pass itself always finishes.
pub async fn purge_due(context: &Context) -> PurgeReport {
    purge_due_with(context, &Fs::new(&context.config)).await
}

/// Purge one group if it is due. See [`purge_root_with`].
pub async fn purge_root(context: &Context, root: Uuid) -> AppResult<Outcome> {
    purge_root_with(context, &Fs::new(&context.config), root).await
}

/// Purge the given groups in the background, for the routes that just marked
/// them due.
pub fn spawn_purge(context: Arc<Context>, roots: Vec<Uuid>) {
    if roots.is_empty() {
        return;
    }

    actix_web::rt::spawn(async move {
        for root in roots {
            if let Err(e) = purge_root(&context, root).await {
                log::warn!("Failed to purge trash group {root}, retrying on the next pass: {e}");
            }
        }
    });
}

/// Purge whatever is due once an hour, starting right away.
///
/// On a thread of its own: on local storage a pass lists chunks with a
/// synchronous directory glob, which must not stall the runtime that drives
/// the server.
pub fn spawn_purger(context: Context) {
    let spawned = std::thread::Builder::new()
        .name("trash-purger".to_string())
        .spawn(move || {
            actix_web::rt::System::new().block_on(async move {
                let mut interval = actix_web::rt::time::interval(PURGE_INTERVAL);
                loop {
                    interval.tick().await;
                    let report = purge_due(&context).await;
                    if report.purged > 0 || report.failed > 0 {
                        log::info!(
                            "Trash purge: {} purged, {} failed, {} skipped",
                            report.purged,
                            report.failed,
                            report.skipped
                        );
                    }
                }
            })
        });
    if let Err(e) = spawned {
        log::error!("Failed to start the trash purger, trash will not empty itself: {e}");
    }
}

pub(crate) async fn purge_due_with<S: ChunkStore>(context: &Context, store: &S) -> PurgeReport {
    let mut report = PurgeReport::default();

    // One snapshot per pass: a group that keeps failing is tried once here
    // and again next hour, never in a loop.
    let roots: Vec<Uuid> = match files::Entity::find()
        .select_only()
        .column(files::Column::TrashRootId)
        .distinct()
        .filter(files::Column::TrashRootId.is_not_null())
        .filter(files::Column::PurgeAt.lte(Utc::now().timestamp()))
        .into_tuple::<Option<Uuid>>()
        .all(&context.db)
        .await
    {
        Ok(roots) => roots.into_iter().flatten().collect(),
        Err(e) => {
            log::warn!("Failed to list trash due for purge: {e}");
            return report;
        }
    };

    for root in roots {
        match purge_root_with(context, store, root).await {
            Ok(Outcome::Purged) => report.purged += 1,
            Ok(Outcome::Skipped) => report.skipped += 1,
            Err(e) => {
                report.failed += 1;
                log::warn!("Failed to purge trash group {root}, retrying on the next pass: {e}");
            }
        }
    }

    report
}

/// Delete one trash group for good, in an order that survives a crash or a
/// storage error at any point:
///
/// 1. Claim the group (`purge_at = 0`), which makes it unrestorable. A
///    restore racing this either ran first, and the claim finds nothing, or
///    runs after, and finds the group claimed.
/// 2. Delete the chunks. On failure the rows stay claimed in the database
///    and the next pass retries; deleting the rows first would orphan
///    chunks nothing could ever find again.
/// 3. Delete the rows, which cascades to keys, tokens, links and versions.
///
/// The group is collected by `trash_root_id`, not by owner, so files other
/// users uploaded into a trashed folder lose their chunks too.
pub(crate) async fn purge_root_with<S: ChunkStore>(
    context: &Context,
    store: &S,
    root: Uuid,
) -> AppResult<Outcome> {
    let now = Utc::now().timestamp();

    let tx = context.db.begin().await?;
    let claimed = files::Entity::update_many()
        .set(files::ActiveModel {
            purge_at: ActiveValue::Set(Some(0)),
            ..Default::default()
        })
        .filter(files::Column::TrashRootId.eq(root))
        .filter(files::Column::PurgeAt.lte(now))
        .exec(&tx)
        .await?
        .rows_affected;
    if claimed == 0 {
        tx.commit().await?;
        return Ok(Outcome::Skipped);
    }
    let group = files::Entity::find()
        .filter(files::Column::TrashRootId.eq(root))
        .all(&tx)
        .await?;
    tx.commit().await?;

    for file in group.iter().filter(|f| f.mime != "dir") {
        store.purge_file(file).await?;
    }

    let tx = context.db.begin().await?;
    // Rows outside the group whose parent is in it (a nested item trashed on
    // its own, or an active row that slipped in under a trashed folder) would
    // otherwise be deleted by the `file_id` cascade. Move them to the root.
    tx.execute(Statement::from_sql_and_values(
        tx.get_database_backend(),
        "UPDATE files SET file_id = NULL \
         WHERE file_id IN (SELECT id FROM files WHERE trash_root_id = $1) \
         AND (trash_root_id IS NULL OR trash_root_id <> $1)",
        [root.into()],
    ))
    .await?;
    files::Entity::delete_many()
        .filter(files::Column::TrashRootId.eq(root))
        .exec(&tx)
        .await?;
    tx.commit().await?;

    cached::evict_all().await;

    Ok(Outcome::Purged)
}
