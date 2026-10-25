use sea_orm_migration::prelude::*;

use crate::m20230409_091730_create_files::Files;

/// Soft delete. A trashed subtree has every row stamped with the same three
/// values: when it was trashed, the id of the item the user trashed (the group
/// restore and purge act on), and when it becomes due for purge. All three are
/// NULL on an active row.
///
/// Also adds the index on `files.file_id` that the recursive subtree walks
/// have always lacked; trash leans on those walks far more than anything did
/// before it.
#[derive(DeriveMigrationName)]
pub(crate) struct Migration;

const COLUMNS: [&str; 3] = ["trashed_at", "trash_root_id", "purge_at"];

const INDEXES: [(&str, &str); 3] = [
    ("idx_files_file_id", "file_id"),
    ("idx_files_trash_root_id", "trash_root_id"),
    ("idx_files_purge_at", "purge_at"),
];

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // One alter per column: SQLite accepts a single alter option per
        // statement.
        manager
            .alter_table(
                Table::alter()
                    .table(Files::Table)
                    .add_column(
                        ColumnDef::new(Alias::new("trashed_at"))
                            .big_integer()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Files::Table)
                    .add_column(ColumnDef::new(Alias::new("trash_root_id")).uuid().null())
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Files::Table)
                    .add_column(ColumnDef::new(Alias::new("purge_at")).big_integer().null())
                    .to_owned(),
            )
            .await?;

        for (name, column) in INDEXES {
            manager
                .create_index(
                    Index::create()
                        .name(name)
                        .table(Files::Table)
                        .col(Alias::new(column))
                        .to_owned(),
                )
                .await?;
        }

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for (name, _) in INDEXES {
            manager
                .drop_index(Index::drop().name(name).table(Files::Table).to_owned())
                .await?;
        }

        for column in COLUMNS.iter().rev() {
            manager
                .alter_table(
                    Table::alter()
                        .table(Files::Table)
                        .drop_column(Alias::new(*column))
                        .to_owned(),
                )
                .await?;
        }

        Ok(())
    }
}
