//! The developer's task list: what is checked before a task is stored, over the [`Store`] port.

use crate::domain::task::{clean_notes, clean_title};
use crate::domain::time::now_rfc3339;
use crate::domain::{Error, ErrorCode, Result, Task, TaskPatch};
use crate::ports::Store;

pub fn list(store: &dyn Store) -> Result<Vec<Task>> {
    store.tasks_list()
}

pub fn get(store: &dyn Store, number: i64) -> Result<Task> {
    store
        .task_get(number)?
        .ok_or_else(|| Error::new(ErrorCode::NotFound, format!("task #{number} not found")))
}

/// A task from a title alone; everything else is filled in later, if ever.
pub fn create(store: &dyn Store, title: &str) -> Result<Task> {
    store.task_create(&clean_title(title)?, &now_rfc3339()?)
}

pub fn update(store: &dyn Store, number: i64, patch: TaskPatch) -> Result<Task> {
    let clean = TaskPatch {
        title: patch.title.as_deref().map(clean_title).transpose()?,
        notes: patch.notes.as_deref().map(clean_notes).transpose()?,
        status: patch.status,
    };
    store
        .task_update(number, &clean, &now_rfc3339()?)?
        .ok_or_else(|| Error::new(ErrorCode::NotFound, format!("task #{number} not found")))
}

pub fn delete(store: &dyn Store, number: i64) -> Result<()> {
    store.task_delete(number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::sqlite::SqliteStore;
    use crate::domain::TaskStatus;

    #[test]
    fn tasks_are_numbered_in_order_and_a_number_is_never_reused() {
        let store = SqliteStore::open_in_memory().unwrap();
        let first = create(&store, "  first thing ").unwrap();
        let second = create(&store, "second").unwrap();
        assert_eq!((first.number, second.number), (1, 2));
        assert_eq!(first.title, "first thing");
        assert_eq!(first.status, TaskStatus::Draft);
        delete(&store, 2).unwrap();
        assert_eq!(create(&store, "third").unwrap().number, 3);
        let listed: Vec<i64> = list(&store)
            .unwrap()
            .iter()
            .map(|task| task.number)
            .collect();
        assert_eq!(listed, vec![3, 1], "newest first");
    }

    #[test]
    fn a_patch_changes_only_what_it_names() {
        let store = SqliteStore::open_in_memory().unwrap();
        let task = create(&store, "write docs").unwrap();
        let ready = update(
            &store,
            task.number,
            TaskPatch {
                status: Some(TaskStatus::Ready),
                ..TaskPatch::default()
            },
        )
        .unwrap();
        assert_eq!(
            (ready.title.as_str(), ready.status),
            ("write docs", TaskStatus::Ready)
        );
        let noted = update(
            &store,
            task.number,
            TaskPatch {
                notes: Some("see the README  \n".into()),
                title: Some("write the docs".into()),
                ..TaskPatch::default()
            },
        )
        .unwrap();
        assert_eq!(noted.notes, "see the README");
        assert_eq!(noted.status, TaskStatus::Ready);
        assert_eq!(get(&store, task.number).unwrap(), noted);
        assert_eq!(
            update(&store, 99, TaskPatch::default()).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert!(
            update(
                &store,
                task.number,
                TaskPatch {
                    title: Some("  ".into()),
                    ..TaskPatch::default()
                }
            )
            .is_err()
        );
    }
}
