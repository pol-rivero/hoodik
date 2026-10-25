use chrono::Utc;
use context::Context;
use entity::{files, ColumnTrait, EntityTrait, QueryFilter};

use crate::{mock::create_file, repository::Repository};

#[actix_web::test]
async fn trashing_a_recursive_mess_stamps_every_row_once() {
    let context = Context::mock_sqlite().await;
    let repository = Repository::new(&context.db);
    let user = entity::mock::create_user(&context.db, "first@test.com", None).await;
    let now = Utc::now().timestamp();

    let mut manual = vec![];

    let dir = create_file(&context, &user, "root.dir", None, Some("dir"))
        .await
        .unwrap();
    let dir_id = dir.id;
    manual.push(dir);

    for name in ["root.json1", "root.json2", "root.json3", "root.json4"] {
        let file = create_file(&context, &user, name, None, Some("application/json"))
            .await
            .unwrap();
        manual.push(file);
    }

    let dir2 = create_file(&context, &user, "root.dir.dir2", Some(dir_id), Some("dir"))
        .await
        .unwrap();
    let dir2_id = dir2.id;
    manual.push(dir2);

    let dir3 = create_file(
        &context,
        &user,
        "root.dir.dir2.dir3",
        Some(dir2_id),
        Some("dir"),
    )
    .await
    .unwrap();
    manual.push(dir3);

    let ids = manual.iter().map(|f| f.id).collect::<Vec<_>>();

    let trash = repository.trash(user.id);
    let roots = trash.roots(&ids).await.unwrap();
    assert_eq!(roots.len(), 5, "the folder and the four root files");

    let mut stamped = 0;
    for root in roots {
        stamped += trash.trash(root, now, now + 1).await.unwrap();
    }
    assert_eq!(stamped as usize, manual.len());

    let still_active = files::Entity::find()
        .filter(files::Column::Id.is_in(ids))
        .filter(files::Column::TrashedAt.is_null())
        .all(&context.db)
        .await
        .unwrap();
    assert!(still_active.is_empty());
}
