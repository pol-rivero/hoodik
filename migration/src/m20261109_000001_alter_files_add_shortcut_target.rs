use sea_orm_migration::prelude::*;

use crate::m20230409_091730_create_files::Files;

/// Shortcuts: a `files` row with `mime = 'shortcut'` that points at another
/// file or folder. Purging the target deletes its shortcuts with it; a
/// trashed target leaves them in place, shown as broken until it is restored.
///
/// The reference is declared inline because SQLite cannot add a foreign key
/// to an existing table any other way; Postgres accepts the same syntax.
#[derive(DeriveMigrationName)]
pub(crate) struct Migration;

const INDEX: &str = "idx_files_shortcut_target_id";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Files::Table)
                    .add_column(
                        ColumnDef::new(Alias::new("shortcut_target_id"))
                            .uuid()
                            .null()
                            .extra(
                                "REFERENCES files(id) ON DELETE CASCADE ON UPDATE NO ACTION"
                                    .to_string(),
                            ),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name(INDEX)
                    .table(Files::Table)
                    .col(Alias::new("shortcut_target_id"))
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(Index::drop().name(INDEX).table(Files::Table).to_owned())
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Files::Table)
                    .drop_column(Alias::new("shortcut_target_id"))
                    .to_owned(),
            )
            .await
    }
}
