//! Trash SQL shared by `storage` and `shares`. It lives here because `shares`
//! must not depend on `storage`.

use error::AppResult;
use sea_orm::{ConnectionTrait, Statement};

use crate::{files, EntityTrait, Uuid};

/// Recursive walk over the subtree rooted at the `$param` placeholder,
/// yielding the id of every row in it, the root included.
///
/// The depth guard is the backstop against a parent cycle: the walk degrades
/// to a bounded one on both SQLite and Postgres instead of looping forever.
pub fn subtree_sql(param: usize) -> String {
    format!(
        "WITH RECURSIVE file_tree(id, depth) AS ( \
            SELECT id, 0 FROM files WHERE id = ${param} \
            UNION ALL \
            SELECT child.id, parent.depth + 1 FROM files child \
            JOIN file_tree parent ON parent.id = child.file_id \
            WHERE parent.depth < 10000 \
        ) SELECT id FROM file_tree"
    )
}

/// Make `top_id` the root of its own trash group, together with every row of
/// its old group that lies inside its subtree.
///
/// Called after `top_id` was re-parented out of the subtree it was trashed
/// with: left in the old group, it would come back or go away with an item it
/// is no longer under, and its owner could neither see nor restore it. A
/// group that is already due or claimed is left alone, since it is about to
/// be deleted.
pub async fn reroot_if_trashed<C: ConnectionTrait>(
    db: &C,
    top_id: Uuid,
    now: i64,
) -> AppResult<()> {
    let Some(top) = files::Entity::find_by_id(top_id).one(db).await? else {
        return Ok(());
    };
    let (Some(old_root), Some(purge_at)) = (top.trash_root_id, top.purge_at) else {
        return Ok(());
    };
    if old_root == top_id || purge_at <= now {
        return Ok(());
    }

    let sql = format!(
        "UPDATE files SET trash_root_id = $1 \
         WHERE trash_root_id = $2 AND purge_at > $3 AND id IN ({})",
        subtree_sql(1)
    );
    db.execute(Statement::from_sql_and_values(
        db.get_database_backend(),
        sql,
        [top_id.into(), old_root.into(), now.into()],
    ))
    .await?;

    Ok(())
}
