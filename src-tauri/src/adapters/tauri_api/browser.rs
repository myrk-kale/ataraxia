//! Commands for the built-in browser, for the window's own use. The agent's tools live in
//! `app/browser_tools.rs`; both go through the same service.

use base64::Engine as _;
use serde::Serialize;

use super::{AppState, map_error};
use crate::domain::browser::{
    BrowserTab, ConsoleEntry, Move, NetEntry, NetFilter, PageError, Profile, Rect, TabId, to_curl,
    to_fetch,
};

type Res<T> = std::result::Result<T, String>;

/// Whether agents may drive the browser at all; kept across runs.
pub const PREF_AGENTS_ALLOWED: &str = "browser_agents_allowed";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    pub tabs: Vec<BrowserTab>,
    pub active: Option<TabId>,
    pub agents_allowed: bool,
}

/// What the debug panel shows of a tab.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogView {
    pub console: Vec<ConsoleEntry>,
    pub errors: Vec<PageError>,
    pub net: Vec<NetEntry>,
    pub mark: u64,
}

#[tauri::command(async)]
pub fn browser_state(state: tauri::State<'_, AppState>) -> BrowserState {
    BrowserState {
        tabs: state.browser.tabs(),
        active: state.browser.active(),
        agents_allowed: state.browser.agents_allowed(),
    }
}

/// Opens a tab of the developer's own, at an address or a search; with nothing, the blank page.
#[tauri::command(async)]
pub fn browser_open(state: tauri::State<'_, AppState>, url: Option<String>) -> Res<BrowserTab> {
    state
        .browser
        .open(url.as_deref(), Profile::User, false)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn browser_close(state: tauri::State<'_, AppState>, id: TabId) -> Res<()> {
    state.browser.close(id).map_err(map_error)
}

#[tauri::command(async)]
pub fn browser_activate(state: tauri::State<'_, AppState>, id: TabId) -> Res<()> {
    state.browser.activate(id).map_err(map_error)
}

#[tauri::command(async)]
pub fn browser_navigate(
    state: tauri::State<'_, AppState>,
    id: TabId,
    input: String,
) -> Res<String> {
    state.browser.navigate(id, &input, false).map_err(map_error)
}

/// `back`, `forward` or `reload`.
#[tauri::command(async)]
pub fn browser_go(state: tauri::State<'_, AppState>, id: TabId, movement: String) -> Res<()> {
    let movement = match movement.as_str() {
        "back" => Move::Back,
        "forward" => Move::Forward,
        "reload" => Move::Reload,
        other => return Err(format!("unknown move {other}")),
    };
    state.browser.go(id, movement).map_err(map_error)
}

#[tauri::command(async)]
pub fn browser_stop(state: tauri::State<'_, AppState>, id: TabId) -> Res<()> {
    state.browser.stop(id).map_err(map_error)
}

/// Where the browser's view is in the window, in logical pixels.
#[tauri::command(async)]
pub fn browser_set_bounds(
    state: tauri::State<'_, AppState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) {
    state.browser.set_bounds(Rect {
        x,
        y,
        width,
        height,
    });
}

/// Whether the browser's view is on screen. A dialog or menu over it hides the pages.
#[tauri::command(async)]
pub fn browser_set_visible(state: tauri::State<'_, AppState>, visible: bool) {
    state.browser.set_visible(visible);
}

/// Hands a tab of the developer's to agents, or takes it back.
#[tauri::command(async)]
pub fn browser_set_agent_control(
    state: tauri::State<'_, AppState>,
    id: TabId,
    allowed: bool,
) -> Res<()> {
    state
        .browser
        .set_agent_control(id, allowed)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn browser_set_agents_allowed(state: tauri::State<'_, AppState>, allowed: bool) -> Res<()> {
    state.browser.set_agents_allowed(allowed);
    state
        .store
        .set_preference(PREF_AGENTS_ALLOWED, if allowed { "1" } else { "0" })
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn browser_logs(state: tauri::State<'_, AppState>, id: TabId) -> Res<LogView> {
    let _ = state.browser.refresh(id);
    state
        .browser
        .logs(id, |logs| LogView {
            console: logs.console.iter().cloned().collect(),
            errors: logs.errors.iter().cloned().collect(),
            net: logs.net.iter().cloned().collect(),
            mark: logs.mark(),
        })
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn browser_clear_logs(state: tauri::State<'_, AppState>, id: TabId) -> Res<()> {
    state.browser.clear_logs(id).map_err(map_error)
}

/// A request as a command to repeat it: `curl` or `fetch`. The developer sees their own
/// credentials; the agent's tools hide them unless asked.
#[tauri::command(async)]
pub fn browser_request_as(
    state: tauri::State<'_, AppState>,
    id: TabId,
    request: String,
    form: String,
) -> Res<String> {
    let entry = state
        .browser
        .logs(id, |logs| {
            logs.net.iter().find(|entry| entry.id == request).cloned()
        })
        .map_err(map_error)?
        .ok_or_else(|| "that request is no longer in the log".to_string())?;
    match form.as_str() {
        "curl" => Ok(to_curl(&entry, true)),
        "fetch" => Ok(to_fetch(&entry, true)),
        other => Err(format!("unknown form {other}")),
    }
}

/// Requests of a tab that match a filter (the panel filters in the window; this is for the list the
/// agent sees, to compare).
#[tauri::command(async)]
pub fn browser_count_requests(state: tauri::State<'_, AppState>, id: TabId) -> Res<usize> {
    let filter = NetFilter::default();
    state
        .browser
        .logs(id, |logs| {
            logs.net
                .iter()
                .filter(|entry| filter.matches(entry))
                .count()
        })
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn browser_devtools(state: tauri::State<'_, AppState>, id: TabId) -> Res<()> {
    state.browser.devtools(id).map_err(map_error)
}

/// A PNG of the tab, base64.
#[tauri::command(async)]
pub fn browser_screenshot(state: tauri::State<'_, AppState>, id: TabId) -> Res<String> {
    let png = state.browser.screenshot(id, None).map_err(map_error)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

/// Forgets what a profile has stored: cookies, site data, cache.
#[tauri::command(async)]
pub fn browser_clear_data(state: tauri::State<'_, AppState>, profile: Profile) -> Res<()> {
    state.browser.clear_data(profile).map_err(map_error)
}

#[tauri::command(async)]
pub fn browser_history(
    state: tauri::State<'_, AppState>,
    workspace_id: crate::domain::ids::WorkspaceId,
) -> Res<Vec<crate::app::browser_history::HistoryEntry>> {
    state
        .browser
        .history
        .as_ref()
        .ok_or_else(|| "Browser history is unavailable".to_string())?
        .list(workspace_id)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn browser_clear_history(
    state: tauri::State<'_, AppState>,
    workspace_id: crate::domain::ids::WorkspaceId,
) -> Res<()> {
    state
        .browser
        .history
        .as_ref()
        .ok_or_else(|| "Browser history is unavailable".to_string())?
        .clear(workspace_id)
        .map_err(map_error)
}
