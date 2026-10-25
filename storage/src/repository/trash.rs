//! The caller's trash. A trashed item takes its whole subtree with it: every
//! row is stamped with the same `trashed_at`, `trash_root_id` and `purge_at`,
//! and restore and purge act on that group. The parent pointers are left
//! alone, so a restored folder comes back with its tree intact.

use std::collections::HashSet;

use entity::{
    files, user_files, ActiveValue, ColumnTrait, ConnectionTrait, EntityTrait, Expr, IntoCondition,
    JoinType, Order, QueryFilter, QueryOrder, QuerySelect, RelationTrait, Statement, Uuid,
};
use error::{AppResult, Error};

use super::Repository;
use crate::data::{
    app_file::AppFile,
    trash::{RestoreResponse, Restored},
};

pub(crate) struct Trash<'repository, T: ConnectionTrait> {
    repository: &'repository Repository<'repository, T>,
    user_id: Uuid,
}

impl<'repository, T> Trash<'repository, T>
where
    T: ConnectionTrait,
{
    pub(crate) fn new(repository: &'repository Repository<'repository, T>, user_id: Uuid) -> Self {
        Self {
            repository,
            user_id,
        }
    }

    /// The ids that become trash roots: `ids` without duplicates and without
    /// any id inside another one's subtree, which joins that one's group.
    pub(crate) async fn roots(&self, ids: &[Uuid]) -> AppResult<Vec<Uuid>> {
        let mut unique: Vec<Uuid> = Vec::with_capacity(ids.len());
        for id in ids {
            if !unique.contains(id) {
                unique.push(*id);
            }
        }

        let manage = self.repository.manage(self.user_id);
        let mut covered: HashSet<Uuid> = HashSet::new();
        for id in &unique {
            covered.extend(
                manage
                    .subtree_ids(*id)
                    .await?
                    .into_iter()
                    .filter(|descendant| descendant != id),
            );
        }

        Ok(unique
            .into_iter()
            .filter(|id| !covered.contains(id))
            .collect())
    }

    /// Stamp every active row under `root`, whoever owns it, into the group
    /// of `root`. Rows already in the trash keep their own group.
    pub(crate) async fn trash(&self, root: Uuid, now: i64, purge_at: i64) -> AppResult<u64> {
        let connection = self.repository.connection();
        let sql = format!(
            "UPDATE files SET trashed_at = $1, trash_root_id = $2, purge_at = $3 \
             WHERE trashed_at IS NULL AND id IN ({})",
            entity::trash::subtree_sql(2)
        );
        let result = connection
            .execute(Statement::from_sql_and_values(
                connection.get_database_backend(),
                sql,
                [now.into(), root.into(), purge_at.into()],
            ))
            .await?;

        Ok(result.rows_affected())
    }

    /// The caller's restorable trash roots, most recently trashed first.
    pub(crate) async fn list(&self, compact: bool, now: i64) -> AppResult<Vec<AppFile>> {
        let items = self
            .repository
            .trash_selector(self.user_id, compact)
            .filter(
                Expr::col((files::Entity, files::Column::Id))
                    .equals((files::Entity, files::Column::TrashRootId)),
            )
            .filter(files::Column::PurgeAt.gt(now))
            .order_by(files::Column::TrashedAt, Order::Desc)
            .into_model::<AppFile>()
            .all(self.repository.connection())
            .await?;

        Ok(items)
    }

    /// Bring trash roots back, each to its original parent when that is still
    /// usable and to the caller's root otherwise. Run inside one transaction.
    ///
    /// Newest-trashed first, except that an item never goes before another
    /// item of the batch that is its ancestor: a folder trashed after its own
    /// child must be back before the child looks for its parent, and
    /// `trashed_at` alone cannot tell two deletes in the same second apart.
    pub(crate) async fn restore(&self, ids: &[Uuid], now: i64) -> AppResult<RestoreResponse> {
        let connection = self.repository.connection();
        let newest_first = self
            .owned_roots(ids)
            .filter(files::Column::PurgeAt.gt(now))
            .order_by(files::Column::TrashedAt, Order::Desc)
            .order_by(files::Column::Id, Order::Asc)
            .all(connection)
            .await?;

        let candidate_ids: HashSet<Uuid> = newest_first.iter().map(|f| f.id).collect();
        let candidates = self.ancestors_first(newest_first, &candidate_ids).await?;
        let mut response = RestoreResponse {
            missing: ids
                .iter()
                .filter(|id| !candidate_ids.contains(id))
                .copied()
                .collect(),
            ..Default::default()
        };

        let manage = self.repository.manage(self.user_id);
        for root in candidates {
            let (target, relocated) = match root.file_id {
                Some(parent) if self.can_restore_into(parent).await? => (Some(parent), false),
                Some(_) => (None, true),
                None => (None, false),
            };

            // Rows waiting for the reindex sweep have no name hash to compare.
            if !root.name_hash.is_empty() {
                match manage.by_name(root.name_hash.as_str(), target).await {
                    Ok(existing) if existing.id != root.id => {
                        response.conflicts.push(root.id);
                        continue;
                    }
                    Ok(_) | Err(Error::NotFound(_)) => {}
                    Err(e) => return Err(e),
                }
            }

            // Conditional on `purge_at`, so a purger that claimed the group in
            // the meantime wins and the item is reported missing instead.
            let restored = files::Entity::update_many()
                .set(files::ActiveModel {
                    trashed_at: ActiveValue::Set(None),
                    trash_root_id: ActiveValue::Set(None),
                    purge_at: ActiveValue::Set(None),
                    ..Default::default()
                })
                .filter(files::Column::TrashRootId.eq(root.id))
                .filter(files::Column::PurgeAt.gt(now))
                .exec(connection)
                .await?
                .rows_affected;
            if restored == 0 {
                response.missing.push(root.id);
                continue;
            }

            // Only the root moves; its descendants keep their parents.
            if relocated {
                files::Entity::update_many()
                    .set(files::ActiveModel {
                        file_id: ActiveValue::Set(None),
                        ..Default::default()
                    })
                    .filter(files::Column::Id.eq(root.id))
                    .exec(connection)
                    .await?;
            }

            response.restored.push(Restored {
                id: root.id,
                file_id: target,
                relocated,
            });
        }

        Ok(response)
    }

    /// Mark the caller's trash roots among `ids` as due now, which also makes
    /// them unrestorable. Returns the roots that were marked; other ids are
    /// ignored.
    pub(crate) async fn mark_due(&self, ids: &[Uuid]) -> AppResult<Vec<Uuid>> {
        let roots: Vec<Uuid> = self
            .owned_roots(ids)
            .select_only()
            .column(files::Column::Id)
            .into_tuple::<Uuid>()
            .all(self.repository.connection())
            .await?;

        self.set_due(roots).await
    }

    /// [`Self::mark_due`] over every trash root the caller owns.
    pub(crate) async fn mark_all_due(&self) -> AppResult<Vec<Uuid>> {
        let roots: Vec<Uuid> = self
            .owned_roots_query()
            .select_only()
            .column(files::Column::Id)
            .into_tuple::<Uuid>()
            .all(self.repository.connection())
            .await?;

        self.set_due(roots).await
    }

    async fn set_due(&self, roots: Vec<Uuid>) -> AppResult<Vec<Uuid>> {
        if roots.is_empty() {
            return Ok(roots);
        }

        // `purge_at` never goes below 0, so this only ever brings it forward.
        files::Entity::update_many()
            .set(files::ActiveModel {
                purge_at: ActiveValue::Set(Some(0)),
                ..Default::default()
            })
            .filter(files::Column::TrashRootId.is_in(roots.clone()))
            .exec(self.repository.connection())
            .await?;

        Ok(roots)
    }

    /// Reorder `items` so that each comes after every other item of the set
    /// that is one of its ancestors, keeping the given order otherwise.
    async fn ancestors_first(
        &self,
        items: Vec<files::Model>,
        ids: &HashSet<Uuid>,
    ) -> AppResult<Vec<files::Model>> {
        let mut pending: Vec<(files::Model, HashSet<Uuid>)> = Vec::with_capacity(items.len());
        for item in items {
            let ancestors: HashSet<Uuid> = self
                .ancestor_ids(item.id)
                .await?
                .into_iter()
                .filter(|id| *id != item.id && ids.contains(id))
                .collect();
            pending.push((item, ancestors));
        }

        let mut ordered = Vec::with_capacity(pending.len());
        let mut placed: HashSet<Uuid> = HashSet::new();
        while !pending.is_empty() {
            // Ancestry is acyclic, so one is always ready; the fallback only
            // guards against a corrupt parent cycle.
            let next = pending
                .iter()
                .position(|(_, ancestors)| ancestors.is_subset(&placed))
                .unwrap_or(0);
            let (item, _) = pending.remove(next);
            placed.insert(item.id);
            ordered.push(item);
        }

        Ok(ordered)
    }

    async fn ancestor_ids(&self, id: Uuid) -> AppResult<Vec<Uuid>> {
        let connection = self.repository.connection();
        let sql = r#"
            WITH RECURSIVE chain(id, file_id, depth) AS (
                SELECT id, file_id, 0 FROM files WHERE id = $1
                UNION ALL
                SELECT f.id, f.file_id, chain.depth + 1 FROM files f
                JOIN chain ON f.id = chain.file_id
                WHERE chain.depth < 10000
            )
            SELECT id FROM chain
        "#;
        let rows = files::Entity::find()
            .from_raw_sql(Statement::from_sql_and_values(
                connection.get_database_backend(),
                sql,
                [id.into()],
            ))
            .into_json()
            .all(connection)
            .await?;

        Ok(rows
            .iter()
            .filter_map(|row| row.get("id")?.as_str()?.parse().ok())
            .collect())
    }

    /// Whether the caller may put a restored item back into `parent`: it
    /// must be an active folder they own or can write to.
    async fn can_restore_into(&self, parent: Uuid) -> AppResult<bool> {
        match self.repository.by_id(parent, self.user_id).await {
            Ok(parent) => Ok(parent.is_dir() && parent.is_writable()),
            Err(Error::NotFound(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn owned_roots(&self, ids: &[Uuid]) -> entity::Select<files::Entity> {
        self.owned_roots_query()
            .filter(files::Column::Id.is_in(ids.iter().copied()))
    }

    fn owned_roots_query(&self) -> entity::Select<files::Entity> {
        let user_id = self.user_id;

        files::Entity::find()
            .join(
                JoinType::InnerJoin,
                files::Relation::UserFiles
                    .def()
                    .on_condition(move |_left, right| {
                        Expr::col((right, user_files::Column::UserId))
                            .eq(user_id)
                            .and(user_files::Column::IsOwner.eq(true))
                            .into_condition()
                    }),
            )
            .filter(
                Expr::col((files::Entity, files::Column::Id))
                    .equals((files::Entity, files::Column::TrashRootId)),
            )
    }
}
