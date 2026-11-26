//! Recent pages, persisted separately for each workspace.
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::domain::browser::{BrowserTab, Profile};
use crate::domain::ids::{SessionId, WorkspaceId};
use crate::domain::{Error, ErrorCode, Result};
use crate::ports::Store;

const LIMIT: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub visited_at: String,
    pub profile: Profile,
}

pub struct BrowserHistory {
    store: Arc<dyn Store>,
    // Serializes read-modify-write operations on each bounded list stored in app_state.
    writing: Mutex<()>,
}

impl BrowserHistory {
    pub fn new(store: Arc<dyn Store>) -> Arc<Self> {
        Arc::new(Self {
            store,
            writing: Mutex::new(()),
        })
    }

    pub fn workspace(&self, session: Option<SessionId>) -> Result<Option<WorkspaceId>> {
        if let Some(session) = session {
            return Ok(self
                .store
                .get_session(session)?
                .and_then(|chat| chat.workspace_id));
        }
        self.store
            .get_preference("selected_workspace_id")?
            .filter(|value| !value.is_empty())
            .map(|value| {
                uuid::Uuid::parse_str(&value)
                    .map(WorkspaceId)
                    .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
            })
            .transpose()
    }

    fn key(workspace: WorkspaceId) -> String {
        format!("browser.history.{}", workspace.0)
    }

    pub fn list(&self, workspace: WorkspaceId) -> Result<Vec<HistoryEntry>> {
        self.store
            .get_preference(&Self::key(workspace))?
            .map(|raw| {
                serde_json::from_str(&raw)
                    .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
            })
            .unwrap_or_else(|| Ok(Vec::new()))
    }

    pub fn clear(&self, workspace: WorkspaceId) -> Result<()> {
        let _guard = self.writing.lock();
        self.store.set_preference(&Self::key(workspace), "[]")
    }

    pub fn observe(
        &self,
        workspace: WorkspaceId,
        tab: &BrowserTab,
        navigation: bool,
    ) -> Result<()> {
        if !url::Url::parse(&tab.url).is_ok_and(|url| matches!(url.scheme(), "http" | "https")) {
            return Ok(());
        }
        let _guard = self.writing.lock();
        let mut entries = self.list(workspace)?;
        let index = entries.iter().position(|entry| entry.url == tab.url);
        if navigation {
            let title = if tab.title.is_empty() {
                index.map(|i| entries[i].title.clone()).unwrap_or_default()
            } else {
                tab.title.clone()
            };
            if let Some(index) = index {
                entries.remove(index);
            }
            entries.insert(
                0,
                HistoryEntry {
                    url: tab.url.clone(),
                    title,
                    profile: tab.profile,
                    visited_at: crate::domain::time::now_rfc3339()?,
                },
            );
            entries.truncate(LIMIT);
        } else if let Some(index) = index {
            if entries[index].title == tab.title || tab.title.is_empty() {
                return Ok(());
            }
            entries[index].title = tab.title.clone();
        } else {
            // Metadata from an already open page must not restore a cleared entry.
            return Ok(());
        }
        let raw = serde_json::to_string(&entries)
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        self.store.set_preference(&Self::key(workspace), &raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::browser::Browser;
    use crate::app::browser::fake::FakeEngine;
    use crate::app::fakes::FakeStore;
    use crate::ports::EngineEvents;

    #[test]
    fn agent_tabs_belong_to_the_chats_workspace_even_when_another_is_selected() {
        let store = Arc::new(FakeStore::healthy());
        let owner = WorkspaceId::new();
        let selected = WorkspaceId::new();
        let session = SessionId::new();
        let chat = serde_json::from_value(serde_json::json!({
            "id": session, "workspace_id": owner,
            "repository_id": uuid::Uuid::new_v4(), "worktree_id": uuid::Uuid::new_v4(),
            "provider": "fake", "title": "Chat", "status": "idle",
            "created_at": "2026-11-26T00:00:00Z", "updated_at": "2026-11-26T00:00:00Z"
        }))
        .unwrap();
        store.create_session(&chat).unwrap();
        store
            .set_preference("selected_workspace_id", &selected.0.to_string())
            .unwrap();
        let history = BrowserHistory::new(store);
        let browser =
            Browser::with_history(FakeEngine::new(), Arc::new(|_| {}), Some(history.clone()));
        let tab = browser
            .open_for_session(Some("https://agent.test"), session)
            .unwrap();
        browser.page_load(tab.id, "https://agent.test/", true);
        assert_eq!(history.list(owner).unwrap().len(), 1);
        assert!(history.list(selected).unwrap().is_empty());
    }

    #[test]
    fn recent_pages_are_bounded_and_repeat_visits_move_to_the_front() {
        let history = BrowserHistory::new(Arc::new(FakeStore::healthy()));
        let workspace = WorkspaceId::new();
        let browser = Browser::new(FakeEngine::new(), Arc::new(|_| {}));
        let mut tab = browser.open(None, Profile::User, false).unwrap();
        for index in 0..=LIMIT {
            tab.url = format!("https://site.test/{index}");
            history.observe(workspace, &tab, true).unwrap();
        }
        let entries = history.list(workspace).unwrap();
        assert_eq!(entries.len(), LIMIT);
        assert!(!entries.iter().any(|entry| entry.url.ends_with("/0")));
        tab.url = "https://site.test/1".into();
        history.observe(workspace, &tab, true).unwrap();
        let entries = history.list(workspace).unwrap();
        assert_eq!(entries.len(), LIMIT);
        assert_eq!(entries[0].url, tab.url);
    }
}
