//! The built-in browser: tabs, their history and logs, and how a page is driven.
//!
//! The browser is a set of webviews the app places over its own window. The developer uses it like
//! any browser; an agent drives it through the tools in `browser_tools.rs`. Both go through this
//! service, which owns the tabs and talks to the platform only through [`BrowserEngine`].
//!
//! A page is looked at and acted on by a script the app injects into it (`adapters/browser/agent.js`).
//! A command runs there and its answer is read back: quick ones at once, ones that have to wait (a
//! wait, an animation) by polling. What pages log (console, errors, requests) is drained from the
//! script every so often into per-tab logs that outlive the page, which is what makes the calls
//! behind a page visible after it has navigated away.
//!
//! Two rules keep this safe. An agent only reaches tabs it opened itself, or that the developer
//! handed over, and the tabs it opens use a separate profile, so it never starts with the
//! developer's logged-in sessions. And no platform call is made with the state lock held: the
//! platform answers through its own event loop, which may be waiting for that same lock.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde_json::{Value, json};

use crate::domain::browser::{
    BrowserEvent, BrowserTab, DEFAULT_VIEW, Drain, History, Logs, Move, Placement, Profile, Rect,
    TabId, agent_may_open, normalize_url,
};
use crate::domain::ids::SessionId;
use crate::domain::{Error, ErrorCode, Result};
use crate::ports::{BrowserEngine, CookieInfo, EngineEvents, TabSpec};

/// How often what pages logged is read back.
const PUMP_EVERY: Duration = Duration::from_millis(700);
/// How long a page gets to answer a script before the platform call is given up on.
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the page that was there is waited on to be replaced before the tab says the new one did
/// not load.
const LOAD_GIVE_UP: Duration = Duration::from_secs(12);
/// How long a command may take unless it says otherwise.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a page that has not installed the bridge yet is waited for.
const BRIDGE_WAIT: Duration = Duration::from_secs(6);

pub type Emit = Arc<dyn Fn(BrowserEvent) + Send + Sync>;

/// What the bridge answered to a command.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Done(Value),
    /// The page went away while the command ran (a click that followed a link, say).
    Navigated,
}

struct Tab {
    info: BrowserTab,
    history: History,
    logs: Logs,
    /// Where the page is drawn now, so the platform is only told about a change.
    placed: Option<Placement>,
    /// What the last tool call to this tab already told the agent about.
    reported: u64,
    reported_url: String,
    reported_title: String,
    /// Drains that failed in a row: a page that does not answer is asked less often.
    silent: u32,
    /// The document that was on screen when the tab began to load something else. While it is the
    /// one answering, "complete" is not the new page's.
    load_from: Option<String>,
    /// When the tab began to load the page it is loading now.
    load_began: Option<Instant>,
}

struct State {
    tabs: BTreeMap<TabId, Tab>,
    order: Vec<TabId>,
    active: Option<TabId>,
    bounds: Option<Rect>,
    visible: bool,
    /// The tab each chat last worked in, so "the tab" means the one it is on.
    current: HashMap<SessionId, TabId>,
}

pub struct Browser {
    engine: Arc<dyn BrowserEngine>,
    emit: Emit,
    state: Mutex<State>,
    /// Signalled when a tab finishes loading or goes away.
    changed: Condvar,
    next: AtomicU32,
    agents_allowed: AtomicBool,
    give_up_ms: AtomicU64,
}

impl Browser {
    pub fn new(engine: Arc<dyn BrowserEngine>, emit: Emit) -> Arc<Self> {
        Arc::new(Self {
            engine,
            emit,
            state: Mutex::new(State {
                tabs: BTreeMap::new(),
                order: Vec::new(),
                active: None,
                bounds: None,
                visible: false,
                current: HashMap::new(),
            }),
            changed: Condvar::new(),
            next: AtomicU32::new(1),
            agents_allowed: AtomicBool::new(true),
            give_up_ms: AtomicU64::new(LOAD_GIVE_UP.as_millis() as u64),
        })
    }

    /// Starts reading back what pages log. The thread ends when the browser is dropped.
    pub fn start_pump(self: &Arc<Self>) {
        let weak: Weak<Browser> = Arc::downgrade(self);
        let _ = std::thread::Builder::new()
            .name("ataraxia-browser-pump".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(PUMP_EVERY);
                    let Some(browser) = weak.upgrade() else {
                        return;
                    };
                    browser.pump_once();
                }
            });
    }

    // ------------------------------------------------------------------ settings

    pub fn agents_allowed(&self) -> bool {
        self.agents_allowed.load(Ordering::SeqCst)
    }

    /// The master switch for agents: off, they can neither open tabs nor look at any.
    pub fn set_agents_allowed(&self, allowed: bool) {
        self.agents_allowed.store(allowed, Ordering::SeqCst);
        self.changed.notify_all();
    }

    // ------------------------------------------------------------------ tabs, for the window

    pub fn tabs(&self) -> Vec<BrowserTab> {
        let state = self.state.lock();
        Self::list(&state)
    }

    pub fn active(&self) -> Option<TabId> {
        self.state.lock().active
    }

    fn list(state: &State) -> Vec<BrowserTab> {
        state
            .order
            .iter()
            .filter_map(|id| state.tabs.get(id))
            .map(|tab| {
                let mut info = tab.info.clone();
                info.can_go_back = tab.history.can_go_back();
                info.can_go_forward = tab.history.can_go_forward();
                info.errors = tab.logs.error_count();
                info.failed_requests = tab.logs.failed_requests();
                info
            })
            .collect()
    }

    fn announce(&self) {
        let event = {
            let state = self.state.lock();
            BrowserEvent::Tabs {
                tabs: Self::list(&state),
                active: state.active,
            }
        };
        (self.emit)(event);
    }

    /// Opens a tab. The developer's own (`by_agent` false) comes to the front; an agent's only does
    /// when the developer is not looking at a tab of their own.
    pub fn open(
        &self,
        input: Option<&str>,
        profile: Profile,
        by_agent: bool,
    ) -> Result<BrowserTab> {
        let url = match input.map(str::trim).filter(|text| !text.is_empty()) {
            Some(text) => normalize_url(text)?,
            None => "about:blank".to_string(),
        };
        if by_agent {
            agent_may_open(&url)?;
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let spec = {
            let mut state = self.state.lock();
            let steal = !by_agent
                || state.active.is_none()
                || !state.visible
                || state
                    .active
                    .and_then(|a| state.tabs.get(&a))
                    .is_some_and(|tab| tab.info.agent_control);
            state.tabs.insert(
                id,
                Tab {
                    info: BrowserTab {
                        id,
                        url: url.clone(),
                        title: String::new(),
                        loading: url != "about:blank",
                        can_go_back: false,
                        can_go_forward: false,
                        favicon: None,
                        profile,
                        agent_control: by_agent,
                        errors: 0,
                        failed_requests: 0,
                        load_error: None,
                    },
                    history: History::new(&url),
                    logs: Logs::default(),
                    placed: None,
                    reported: 0,
                    reported_url: String::new(),
                    reported_title: String::new(),
                    silent: 0,
                    load_from: None,
                    load_began: None,
                },
            );
            state.order.push(id);
            if steal {
                state.active = Some(id);
            }
            let placement = Self::placement(&state, id);
            if let Some(tab) = state.tabs.get_mut(&id) {
                tab.placed = Some(placement);
            }
            TabSpec {
                id,
                url,
                profile,
                placement,
            }
        };
        if let Err(error) = self.engine.create(&spec) {
            let mut state = self.state.lock();
            state.tabs.remove(&id);
            state.order.retain(|other| *other != id);
            if state.active == Some(id) {
                state.active = state.order.last().copied();
            }
            drop(state);
            self.announce();
            return Err(error);
        }
        self.reflow();
        self.announce();
        self.tabs()
            .into_iter()
            .find(|tab| tab.id == id)
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "the tab went away"))
    }

    pub fn close(&self, id: TabId) -> Result<()> {
        {
            let mut state = self.state.lock();
            if state.tabs.remove(&id).is_none() {
                return Err(Error::new(
                    ErrorCode::NotFound,
                    format!("there is no tab {id}"),
                ));
            }
            state.order.retain(|other| *other != id);
            state.current.retain(|_, tab| *tab != id);
            if state.active == Some(id) {
                state.active = state.order.last().copied();
            }
        }
        // The page may already be gone with its window; a close that fails changes nothing here.
        let _ = self.engine.close(id);
        self.changed.notify_all();
        self.reflow();
        self.announce();
        Ok(())
    }

    pub fn activate(&self, id: TabId) -> Result<()> {
        {
            let mut state = self.state.lock();
            if !state.tabs.contains_key(&id) {
                return Err(Error::new(
                    ErrorCode::NotFound,
                    format!("there is no tab {id}"),
                ));
            }
            state.active = Some(id);
        }
        self.reflow();
        self.announce();
        Ok(())
    }

    /// Where the browser's view is on screen, as the window measured it.
    pub fn set_bounds(&self, bounds: Rect) {
        if !bounds.is_usable() {
            return;
        }
        {
            let mut state = self.state.lock();
            if state.bounds == Some(bounds) {
                return;
            }
            state.bounds = Some(bounds);
        }
        self.reflow();
    }

    /// Whether the browser's view is on screen (the space is open and nothing covers it).
    pub fn set_visible(&self, visible: bool) {
        {
            let mut state = self.state.lock();
            if state.visible == visible {
                return;
            }
            state.visible = visible;
        }
        self.reflow();
    }

    pub fn set_agent_control(&self, id: TabId, allowed: bool) -> Result<()> {
        {
            let mut state = self.state.lock();
            let tab = state
                .tabs
                .get_mut(&id)
                .ok_or_else(|| Error::new(ErrorCode::NotFound, format!("there is no tab {id}")))?;
            tab.info.agent_control = allowed;
            if !allowed {
                state.current.retain(|_, current| *current != id);
            }
        }
        self.changed.notify_all();
        self.announce();
        Ok(())
    }

    fn placement(state: &State, id: TabId) -> Placement {
        let view = state.bounds.filter(Rect::is_usable);
        match view {
            Some(rect) if state.visible && state.active == Some(id) => Placement::Visible(rect),
            Some(rect) => Placement::Parked {
                width: rect.width,
                height: rect.height,
            },
            None => Placement::Parked {
                width: DEFAULT_VIEW.0,
                height: DEFAULT_VIEW.1,
            },
        }
    }

    /// Moves every page that is not where it should be. The platform is told with no lock held.
    fn reflow(&self) {
        let moves: Vec<(TabId, Placement)> = {
            let mut state = self.state.lock();
            let wanted: Vec<(TabId, Placement)> = state
                .order
                .iter()
                .map(|id| (*id, Self::placement(&state, *id)))
                .collect();
            wanted
                .into_iter()
                .filter(|(id, placement)| {
                    let tab = state.tabs.get_mut(id);
                    match tab {
                        Some(tab) if tab.placed != Some(*placement) => {
                            tab.placed = Some(*placement);
                            true
                        }
                        _ => false,
                    }
                })
                .collect()
        };
        for (id, placement) in moves {
            if self.engine.place(id, placement).is_err() {
                if let Some(tab) = self.state.lock().tabs.get_mut(&id) {
                    tab.placed = None;
                }
            }
        }
    }

    // ------------------------------------------------------------------ navigation

    pub fn navigate(&self, id: TabId, input: &str, by_agent: bool) -> Result<String> {
        let url = normalize_url(input)?;
        if by_agent {
            agent_may_open(&url)?;
        }
        self.begin_load(id, Some(&url))?;
        self.engine.navigate(id, &url)?;
        Ok(url)
    }

    pub fn go(&self, id: TabId, movement: Move) -> Result<()> {
        {
            let mut state = self.state.lock();
            let tab = state
                .tabs
                .get_mut(&id)
                .ok_or_else(|| Error::new(ErrorCode::NotFound, format!("there is no tab {id}")))?;
            match movement {
                Move::Back if !tab.history.can_go_back() => {
                    return Err(Error::new(
                        ErrorCode::Invalid,
                        "there is nothing to go back to",
                    ));
                }
                Move::Forward if !tab.history.can_go_forward() => {
                    return Err(Error::new(
                        ErrorCode::Invalid,
                        "there is nothing to go forward to",
                    ));
                }
                _ => {}
            }
            tab.history.expect(movement);
            tab.info.loading = true;
            tab.info.load_error = None;
            tab.load_began = Some(Instant::now());
            tab.load_from = Some(tab.logs.cursor().0.to_string());
        }
        self.announce();
        let script = match movement {
            Move::Back => "history.back()",
            Move::Forward => "history.forward()",
            Move::Reload => "location.reload()",
        };
        self.engine.eval(
            id,
            &format!("(function(){{{script};return 1}})()"),
            EVAL_TIMEOUT,
        )?;
        Ok(())
    }

    pub fn stop(&self, id: TabId) -> Result<()> {
        self.engine
            .eval(id, "(function(){window.stop();return 1})()", EVAL_TIMEOUT)?;
        {
            let mut state = self.state.lock();
            if let Some(tab) = state.tabs.get_mut(&id) {
                tab.info.loading = false;
            }
        }
        self.changed.notify_all();
        self.announce();
        Ok(())
    }

    fn begin_load(&self, id: TabId, url: Option<&str>) -> Result<()> {
        {
            let mut state = self.state.lock();
            let tab = state
                .tabs
                .get_mut(&id)
                .ok_or_else(|| Error::new(ErrorCode::NotFound, format!("there is no tab {id}")))?;
            tab.info.loading = true;
            tab.info.load_error = None;
            tab.load_began = Some(Instant::now());
            tab.load_from = Some(tab.logs.cursor().0.to_string());
            if let Some(url) = url {
                tab.info.url = url.to_string();
            }
        }
        self.announce();
        Ok(())
    }

    /// Waits until the tab has stopped loading. Returns whether it did within the time.
    pub fn wait_loaded(&self, id: TabId, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock();
        loop {
            match state.tabs.get(&id) {
                None => return false,
                Some(tab) if !tab.info.loading => return true,
                Some(_) => {}
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            self.changed.wait_for(&mut state, deadline - now);
        }
    }

    // ------------------------------------------------------------------ logs

    pub fn logs<T>(&self, id: TabId, read: impl FnOnce(&Logs) -> T) -> Result<T> {
        let state = self.state.lock();
        let tab = state
            .tabs
            .get(&id)
            .ok_or_else(|| Error::new(ErrorCode::NotFound, format!("there is no tab {id}")))?;
        Ok(read(&tab.logs))
    }

    pub fn clear_logs(&self, id: TabId) -> Result<()> {
        {
            let mut state = self.state.lock();
            let tab = state
                .tabs
                .get_mut(&id)
                .ok_or_else(|| Error::new(ErrorCode::NotFound, format!("there is no tab {id}")))?;
            tab.logs.clear();
            tab.reported = tab.logs.mark();
        }
        self.announce();
        Ok(())
    }

    /// Reads what the page logged since the last time, into the tab's logs.
    pub fn refresh(&self, id: TabId) -> Result<()> {
        let (page, since) = {
            let state = self.state.lock();
            let tab = state
                .tabs
                .get(&id)
                .ok_or_else(|| Error::new(ErrorCode::NotFound, format!("there is no tab {id}")))?;
            let (page, since) = tab.logs.cursor();
            (page.to_string(), since)
        };
        let script = format!(
            "window.__ataraxia ? __ataraxia.drain({since}, {}) : 'null'",
            json!(page)
        );
        let raw = self.eval_text(id, &script)?;
        if raw == "null" {
            return Ok(());
        }
        let drain: Drain = serde_json::from_str(&raw).map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("the page's log could not be read: {error}"),
            )
        })?;
        let changed = {
            let mut state = self.state.lock();
            let Some(tab) = state.tabs.get_mut(&id) else {
                return Ok(());
            };
            tab.silent = 0;
            let mut meta = drain.meta.clone();
            if meta.page_id.is_empty() {
                meta.page_id = drain.page_id.clone();
            }
            let mut changed = tab.logs.apply(drain);
            if !meta.title.is_empty() && meta.title != tab.info.title {
                tab.info.title = meta.title;
                changed = true;
            }
            if !meta.url.is_empty() && meta.url != tab.info.url && meta.url != "about:blank" {
                // The page changed its own address (a single-page app moving on).
                tab.history.observe(&meta.url);
                tab.info.url = meta.url;
                changed = true;
            }
            let icon = (!meta.favicon.is_empty()).then_some(meta.favicon);
            if icon != tab.info.favicon {
                tab.info.favicon = icon;
                changed = true;
            }
            let give_up = self.give_up_ms.load(Ordering::SeqCst);
            let new_document = tab.load_from.as_deref() != Some(meta.page_id.as_str());
            if meta.ready_state == "complete"
                && tab.info.loading
                && meta.pending == 0
                && new_document
            {
                // The platform said the page loaded; this is the page agreeing.
                tab.info.loading = false;
                tab.load_from = None;
                changed = true;
            } else if tab.info.loading
                && !new_document
                && tab
                    .load_began
                    .is_some_and(|began| began.elapsed() > Duration::from_millis(give_up))
            {
                // The old page is still the one answering: the new one never came (the address
                // was refused, the server is down, or it is very slow).
                tab.info.loading = false;
                tab.load_from = None;
                tab.info.load_error = Some("the page did not load: it was blocked, the server did not answer, or it is very slow".into());
                changed = true;
            }
            changed
        };
        if changed {
            self.changed.notify_all();
            self.announce();
        }
        Ok(())
    }

    fn pump_once(&self) {
        let ids: Vec<(TabId, u32)> = {
            let state = self.state.lock();
            state
                .order
                .iter()
                .filter_map(|id| state.tabs.get(id).map(|tab| (*id, tab.silent)))
                .collect()
        };
        for (id, silent) in ids {
            // A page that has not answered is asked every few rounds instead of every one.
            if silent > 3 && silent % 5 != 0 {
                if let Some(tab) = self.state.lock().tabs.get_mut(&id) {
                    tab.silent += 1;
                }
                continue;
            }
            if self.refresh(id).is_err() {
                if let Some(tab) = self.state.lock().tabs.get_mut(&id) {
                    tab.silent += 1;
                }
            }
        }
    }

    // ------------------------------------------------------------------ running things in a page

    /// Runs a script and returns what it answered, which must be a string.
    pub(crate) fn eval_text(&self, id: TabId, script: &str) -> Result<String> {
        let raw = self.engine.eval(id, script, EVAL_TIMEOUT)?;
        serde_json::from_str::<String>(&raw)
            .map_err(|_| Error::new(ErrorCode::Io, "the page did not answer with text"))
    }

    fn eval_json(&self, id: TabId, script: &str) -> Result<Value> {
        let text = self.eval_text(id, script)?;
        serde_json::from_str(&text).map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("the page's answer could not be read: {error}"),
            )
        })
    }

    fn still_controlled(&self, id: TabId, by_agent: bool) -> Result<()> {
        let state = self.state.lock();
        let tab = state
            .tabs
            .get(&id)
            .ok_or_else(|| Error::new(ErrorCode::NotFound, format!("tab {id} was closed")))?;
        if by_agent && (!tab.info.agent_control || !self.agents_allowed()) {
            return Err(Error::new(
                ErrorCode::Invalid,
                "the developer took control of this tab",
            ));
        }
        Ok(())
    }

    /// Runs a script that starts a command in the page and follows it to its end. `start` is the
    /// expression that starts it (`__ataraxia.run(id, {...})`), `id` is what polling asks for.
    pub(crate) fn run_script(
        &self,
        tab: TabId,
        id: &str,
        start: &str,
        timeout: Duration,
        by_agent: bool,
    ) -> Result<Outcome> {
        let deadline = Instant::now() + timeout;
        let guarded = format!("window.__ataraxia ? {start} : JSON.stringify({{missing:true}})");
        // A page that is still loading has no bridge yet: give it a moment.
        let bridge_deadline = Instant::now() + BRIDGE_WAIT;
        let mut answer = loop {
            self.still_controlled(tab, by_agent)?;
            let answer = self.eval_json(tab, &guarded)?;
            if answer.get("missing").is_none() {
                break answer;
            }
            if Instant::now() >= bridge_deadline {
                return Err(Error::new(
                    ErrorCode::Invalid,
                    "the page is not ready: it has not finished loading, or it blocks scripts",
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let poll = format!(
            "window.__ataraxia ? __ataraxia.poll({}) : JSON.stringify({{gone:true}})",
            json!(id)
        );
        loop {
            if answer.get("gone").is_some() || answer.get("missing").is_some() {
                return Ok(Outcome::Navigated);
            }
            if answer.get("pending").is_none()
                && answer.get("done").and_then(Value::as_bool) == Some(true)
            {
                if let Some(error) = answer.get("error").and_then(Value::as_str) {
                    return Err(Error::new(ErrorCode::Invalid, error));
                }
                return Ok(Outcome::Done(
                    answer.get("value").cloned().unwrap_or(Value::Null),
                ));
            }
            if Instant::now() >= deadline {
                return Err(Error::new(
                    ErrorCode::Agent,
                    format!("the page did not finish within {}s", timeout.as_secs()),
                ));
            }
            std::thread::sleep(Duration::from_millis(40));
            self.still_controlled(tab, by_agent)?;
            answer = self.eval_json(tab, &poll)?;
        }
    }

    /// Runs one of the bridge's commands.
    pub fn command(
        &self,
        tab: TabId,
        command: &Value,
        timeout: Option<Duration>,
        by_agent: bool,
    ) -> Result<Outcome> {
        let id = format!("c{}", uuid::Uuid::new_v4().simple());
        let start = format!("__ataraxia.run({}, {})", json!(id), command);
        self.run_script(
            tab,
            &id,
            &start,
            timeout.unwrap_or(COMMAND_TIMEOUT),
            by_agent,
        )
    }

    /// Runs the developer's (or an agent's) own expression in the page, with `await` available.
    pub fn evaluate(&self, tab: TabId, expression: &str, by_agent: bool) -> Result<Outcome> {
        let id = format!("c{}", uuid::Uuid::new_v4().simple());
        // The code is part of the script handed to the platform, not run through `eval` in the page:
        // a page that forbids `eval` in its policy still lets this run.
        let start = format!(
            "__ataraxia.exec({}, function(){{ return (async () => (\n{expression}\n))(); }})",
            json!(id)
        );
        self.run_script(tab, &id, &start, COMMAND_TIMEOUT, by_agent)
    }

    pub fn screenshot(&self, tab: TabId, clip: Option<Rect>) -> Result<Vec<u8>> {
        self.engine.screenshot(tab, clip)
    }

    pub fn devtools(&self, tab: TabId) -> Result<()> {
        self.engine.devtools(tab)
    }

    pub fn cookies(&self, tab: TabId) -> Result<Vec<CookieInfo>> {
        let url = {
            let state = self.state.lock();
            state
                .tabs
                .get(&tab)
                .map(|tab| tab.info.url.clone())
                .ok_or_else(|| Error::new(ErrorCode::NotFound, format!("there is no tab {tab}")))?
        };
        self.engine.cookies(tab, &url)
    }

    pub fn clear_data(&self, profile: Profile) -> Result<()> {
        self.engine.clear_data(profile)
    }

    // ------------------------------------------------------------------ what an agent may reach

    /// The tab an agent call is about: the one named, else the chat's current one, else the only
    /// one the agent has. A tab the developer has not handed over is refused, and says why.
    pub(crate) fn agent_tab(&self, session: SessionId, named: Option<TabId>) -> Result<TabId> {
        if !self.agents_allowed() {
            return Err(Error::new(
                ErrorCode::Invalid,
                "the developer has switched agent control of the browser off (it is in the browser's menu)",
            ));
        }
        let state = self.state.lock();
        let id = match named {
            Some(id) => id,
            None => {
                let current = state
                    .current
                    .get(&session)
                    .copied()
                    .filter(|id| state.tabs.get(id).is_some_and(|tab| tab.info.agent_control));
                let reachable: Vec<TabId> = state
                    .order
                    .iter()
                    .copied()
                    .filter(|id| state.tabs.get(id).is_some_and(|tab| tab.info.agent_control))
                    .collect();
                match (current, reachable.as_slice()) {
                    (Some(id), _) => id,
                    (None, [only]) => *only,
                    (None, []) => {
                        return Err(Error::new(
                            ErrorCode::NotFound,
                            "there is no tab you can use: open one with browser_tabs (action open)",
                        ));
                    }
                    (None, many) => {
                        return Err(Error::new(
                            ErrorCode::Invalid,
                            format!(
                                "which tab? you can use {}: pass `tab`",
                                many.iter()
                                    .map(u32::to_string)
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ),
                        ));
                    }
                }
            }
        };
        match state.tabs.get(&id) {
            None => Err(Error::new(
                ErrorCode::NotFound,
                format!("there is no tab {id}"),
            )),
            Some(tab) if !tab.info.agent_control => Err(Error::new(
                ErrorCode::Invalid,
                format!(
                    "tab {id} is the developer's own and is not shared with you: ask them to turn on Agent control for it, or open a tab of your own"
                ),
            )),
            Some(_) => Ok(id),
        }
    }

    pub(crate) fn remember_current(&self, session: SessionId, tab: TabId) {
        self.state.lock().current.insert(session, tab);
    }

    pub(crate) fn tab_info(&self, id: TabId) -> Option<BrowserTab> {
        self.tabs().into_iter().find(|tab| tab.id == id)
    }

    pub(crate) fn agent_activity(&self, tab: TabId, busy: bool, action: &str) {
        (self.emit)(BrowserEvent::Agent {
            tab,
            busy,
            action: action.to_string(),
        });
    }

    /// What changed in a tab since an agent was last told: the address and title, and how many
    /// errors and failed requests the page logged. Marks it as told.
    pub(crate) fn changes_since_told(&self, id: TabId) -> Vec<String> {
        let _ = self.refresh(id);
        let mut state = self.state.lock();
        let Some(tab) = state.tabs.get_mut(&id) else {
            return Vec::new();
        };
        let mut notes = Vec::new();
        let url = tab.info.url.clone();
        let title = tab.info.title.clone();
        if tab.reported_url != url || tab.reported_title != title {
            if !tab.reported_url.is_empty() || !url.is_empty() {
                notes.push(format!(
                    "page: {} {url}",
                    serde_json::to_string(&title).unwrap_or_default()
                ));
            }
            tab.reported_url = url;
            tab.reported_title = title;
        }
        let after = tab.reported;
        let errors = tab
            .logs
            .console
            .iter()
            .filter(|entry| entry.seq > after && entry.level == "error")
            .count()
            + tab
                .logs
                .errors
                .iter()
                .filter(|entry| entry.seq > after)
                .count();
        let failed = tab
            .logs
            .net
            .iter()
            .filter(|entry| entry.seq > after && entry.failed())
            .count();
        if errors > 0 {
            notes.push(format!(
                "{errors} new console error{} (browser_console)",
                if errors == 1 { "" } else { "s" }
            ));
        }
        if failed > 0 {
            notes.push(format!(
                "{failed} new failed request{} (browser_network with status failed)",
                if failed == 1 { "" } else { "s" }
            ));
        }
        tab.reported = tab.logs.mark();
        notes
    }

    #[cfg(test)]
    pub(crate) fn set_load_give_up(&self, wait: Duration) {
        self.give_up_ms
            .store(wait.as_millis() as u64, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(crate) fn tab_loading(&self, id: TabId) -> bool {
        self.state
            .lock()
            .tabs
            .get(&id)
            .is_some_and(|tab| tab.info.loading)
    }
}

impl EngineEvents for Browser {
    fn page_load(&self, id: TabId, url: &str, finished: bool) {
        {
            let mut state = self.state.lock();
            let Some(tab) = state.tabs.get_mut(&id) else {
                return;
            };
            if url != "about:blank" || tab.info.url == "about:blank" {
                tab.history.observe(url);
                tab.info.url = url.to_string();
            }
            tab.info.loading = !finished;
            if finished {
                tab.load_from = None;
                tab.info.load_error = None;
            } else {
                tab.info.title = String::new();
            }
        }
        if finished {
            self.changed.notify_all();
        }
        self.announce();
    }

    fn title(&self, id: TabId, title: &str) {
        {
            let mut state = self.state.lock();
            let Some(tab) = state.tabs.get_mut(&id) else {
                return;
            };
            if tab.info.title == title {
                return;
            }
            tab.info.title = title.to_string();
        }
        self.announce();
    }

    fn navigating(&self, _id: TabId, url: &str) -> bool {
        // Pages move between web addresses and the blank page. Anything else (an app's own scheme,
        // a script, a file a web page points at) stays out.
        url == "about:blank"
            || url::Url::parse(url)
                .is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https" | "file" | "blob"))
    }

    fn popup(&self, from: TabId, url: &str) {
        let (profile, by_agent) = {
            let state = self.state.lock();
            match state.tabs.get(&from) {
                Some(tab) => (
                    tab.info.profile,
                    tab.info.agent_control && tab.info.profile == Profile::Agent,
                ),
                None => (Profile::User, false),
            }
        };
        // A page's new window is a tab of the same kind as the page that asked for it.
        let _ = self.open(Some(url), profile, by_agent);
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use super::*;

    type Script = Box<dyn Fn(TabId, &str) -> Result<String> + Send + Sync>;

    /// A platform that records what it was asked and answers scripts from a function.
    pub struct FakeEngine {
        pub calls: Mutex<Vec<String>>,
        pub script: Mutex<Script>,
        pub png: Mutex<Result<Vec<u8>>>,
        pub fail_create: AtomicBool,
        pub cookies: Mutex<Vec<CookieInfo>>,
    }

    impl FakeEngine {
        pub fn new() -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                script: Mutex::new(Box::new(|_, _| Ok("\"null\"".into()))),
                png: Mutex::new(Ok(vec![0x89, b'P', b'N', b'G'])),
                fail_create: AtomicBool::new(false),
                cookies: Mutex::new(Vec::new()),
            })
        }

        pub fn answer(
            &self,
            script: impl Fn(TabId, &str) -> Result<String> + Send + Sync + 'static,
        ) {
            *self.script.lock() = Box::new(script);
        }

        pub fn log(&self) -> Vec<String> {
            self.calls.lock().clone()
        }
    }

    /// What a page answers: the string, as the platform would encode it.
    pub fn text(value: Value) -> Result<String> {
        Ok(serde_json::to_string(&value.to_string()).expect("a string"))
    }

    impl BrowserEngine for FakeEngine {
        fn create(&self, spec: &TabSpec) -> Result<()> {
            if self.fail_create.load(Ordering::SeqCst) {
                return Err(Error::new(ErrorCode::Io, "no webview"));
            }
            self.calls.lock().push(format!(
                "create {} {} {:?} {:?}",
                spec.id, spec.url, spec.profile, spec.placement
            ));
            Ok(())
        }
        fn close(&self, id: TabId) -> Result<()> {
            self.calls.lock().push(format!("close {id}"));
            Ok(())
        }
        fn navigate(&self, id: TabId, url: &str) -> Result<()> {
            self.calls.lock().push(format!("navigate {id} {url}"));
            Ok(())
        }
        fn place(&self, id: TabId, placement: Placement) -> Result<()> {
            self.calls.lock().push(format!("place {id} {placement:?}"));
            Ok(())
        }
        fn eval(&self, id: TabId, script: &str, _timeout: Duration) -> Result<String> {
            self.calls.lock().push(format!("eval {id} {script}"));
            (self.script.lock())(id, script)
        }
        fn screenshot(&self, id: TabId, clip: Option<Rect>) -> Result<Vec<u8>> {
            self.calls.lock().push(format!("screenshot {id} {clip:?}"));
            self.png.lock().clone()
        }
        fn devtools(&self, id: TabId) -> Result<()> {
            self.calls.lock().push(format!("devtools {id}"));
            Ok(())
        }
        fn cookies(&self, _id: TabId, _url: &str) -> Result<Vec<CookieInfo>> {
            Ok(self.cookies.lock().clone())
        }
        fn clear_data(&self, profile: Profile) -> Result<()> {
            self.calls.lock().push(format!("clear {profile:?}"));
            Ok(())
        }
    }

    pub fn browser() -> (Arc<Browser>, Arc<FakeEngine>, Arc<Mutex<Vec<BrowserEvent>>>) {
        let engine = FakeEngine::new();
        let events: Arc<Mutex<Vec<BrowserEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let browser = Browser::new(
            engine.clone(),
            Arc::new(move |event| sink.lock().push(event)),
        );
        (browser, engine, events)
    }
}

#[cfg(test)]
mod tests {
    use super::fake::*;
    use super::*;

    fn open(browser: &Browser, url: &str) -> BrowserTab {
        browser.open(Some(url), Profile::User, false).expect("open")
    }

    #[test]
    fn a_tab_opens_at_the_address_typed_and_the_first_one_comes_to_the_front() {
        let (browser, engine, events) = browser();
        let tab = open(&browser, "example.com");
        assert_eq!(tab.id, 1);
        assert_eq!(tab.url, "https://example.com/");
        assert!(tab.loading && !tab.agent_control);
        assert_eq!(browser.active(), Some(1));
        let second = open(&browser, "localhost:3000");
        assert_eq!(second.id, 2);
        assert_eq!(
            browser.active(),
            Some(2),
            "the developer's own tab comes to the front"
        );
        assert_eq!(browser.tabs().len(), 2);
        assert!(engine.log()[0].starts_with("create 1 https://example.com/ User Parked"));
        assert!(matches!(
            events.lock().last(),
            Some(BrowserEvent::Tabs {
                active: Some(2),
                ..
            })
        ));
        // An empty address is the blank page; one that cannot be opened is refused.
        assert_eq!(
            browser.open(None, Profile::User, false).unwrap().url,
            "about:blank"
        );
        assert!(
            browser
                .open(Some("javascript:alert(1)"), Profile::User, false)
                .is_err()
        );
    }

    #[test]
    fn a_tab_that_cannot_be_made_leaves_nothing_behind() {
        let (browser, engine, _) = browser();
        engine.fail_create.store(true, Ordering::SeqCst);
        assert!(
            browser
                .open(Some("example.com"), Profile::User, false)
                .is_err()
        );
        assert!(browser.tabs().is_empty());
        assert_eq!(browser.active(), None);
    }

    #[test]
    fn closing_a_tab_moves_to_another_and_forgets_it() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        open(&browser, "b.test");
        open(&browser, "c.test");
        browser.close(3).unwrap();
        assert_eq!(browser.active(), Some(2));
        assert_eq!(
            browser.tabs().iter().map(|t| t.id).collect::<Vec<_>>(),
            [1, 2]
        );
        assert!(engine.log().contains(&"close 3".to_string()));
        assert!(browser.close(3).is_err());
        browser.close(2).unwrap();
        browser.close(1).unwrap();
        assert_eq!(browser.active(), None);
    }

    #[test]
    fn only_the_tab_in_view_is_on_screen_and_the_rest_are_parked_at_the_same_size() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        open(&browser, "b.test");
        let view = Rect {
            x: 0.0,
            y: 80.0,
            width: 900.0,
            height: 600.0,
        };
        browser.set_bounds(view);
        browser.set_visible(true);
        let log = engine.log();
        assert!(
            log.iter()
                .any(|call| call == &format!("place 2 {:?}", Placement::Visible(view)))
        );
        assert!(log.iter().any(|call| call
            == &format!(
                "place 1 {:?}",
                Placement::Parked {
                    width: 900.0,
                    height: 600.0
                }
            )));
        // Something covers the view (a dialog): every page steps aside.
        engine.calls.lock().clear();
        browser.set_visible(false);
        assert_eq!(engine.log().len(), 1);
        assert!(engine.log()[0].starts_with("place 2 Parked"));
        // Nothing is said twice.
        browser.set_visible(false);
        browser.set_bounds(view);
        assert_eq!(engine.log().len(), 1);
        // Another tab comes to the front.
        browser.set_visible(true);
        engine.calls.lock().clear();
        browser.activate(1).unwrap();
        assert_eq!(engine.log().len(), 2);
        assert!(browser.activate(9).is_err());
        // A view that has no size is ignored.
        browser.set_bounds(Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        });
        assert_eq!(engine.log().len(), 2);
    }

    #[test]
    fn what_the_platform_says_about_a_page_updates_the_tab_and_its_history() {
        let (browser, _, _) = browser();
        open(&browser, "a.test");
        browser.page_load(1, "https://a.test/", true);
        browser.title(1, "A");
        assert!(!browser.tab_loading(1));
        browser.page_load(1, "https://a.test/next", false);
        assert!(browser.tab_loading(1));
        browser.page_load(1, "https://a.test/next", true);
        let tab = browser.tabs().remove(0);
        assert_eq!(
            (tab.url.as_str(), tab.can_go_back, tab.can_go_forward),
            ("https://a.test/next", true, false)
        );
        assert_eq!(
            tab.title, "",
            "the title of the old page is dropped when a new one starts"
        );
        browser.title(1, "Next");
        assert_eq!(browser.tabs()[0].title, "Next");
        // About the tab that is gone: nothing happens.
        browser.page_load(7, "https://x.test/", true);
        browser.title(7, "x");
    }

    #[test]
    fn going_back_and_forward_follows_the_history_and_refuses_when_there_is_none() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        assert!(browser.go(1, Move::Back).is_err());
        browser.page_load(1, "https://a.test/two", true);
        browser.go(1, Move::Back).unwrap();
        assert!(
            engine
                .log()
                .iter()
                .any(|call| call.contains("history.back()"))
        );
        browser.page_load(1, "https://a.test/", true);
        let tab = browser.tabs().remove(0);
        assert!(!tab.can_go_back && tab.can_go_forward);
        browser.go(1, Move::Forward).unwrap();
        browser.page_load(1, "https://a.test/two", true);
        assert!(browser.go(1, Move::Forward).is_err());
        browser.go(1, Move::Reload).unwrap();
        assert!(
            engine
                .log()
                .iter()
                .any(|call| call.contains("location.reload()"))
        );
        assert!(browser.go(9, Move::Back).is_err());
    }

    #[test]
    fn navigating_marks_the_tab_loading_and_waiting_returns_when_it_has_loaded() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        browser.page_load(1, "https://a.test/", true);
        let url = browser.navigate(1, "b.test/docs", false).unwrap();
        assert_eq!(url, "https://b.test/docs");
        assert!(browser.tab_loading(1));
        assert!(
            engine
                .log()
                .contains(&"navigate 1 https://b.test/docs".to_string())
        );
        assert!(
            !browser.wait_loaded(1, Duration::from_millis(30)),
            "still loading when the time is up"
        );
        let finisher = {
            let browser = Arc::clone(&browser);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(40));
                browser.page_load(1, "https://b.test/docs", true);
            })
        };
        assert!(browser.wait_loaded(1, Duration::from_secs(5)));
        finisher.join().unwrap();
        assert!(
            !browser.wait_loaded(9, Duration::from_millis(10)),
            "a tab that is not there never loads"
        );
        assert!(browser.navigate(1, "", false).is_err());
        assert!(browser.navigate(9, "a.test", false).is_err());
    }

    #[test]
    fn an_agent_may_only_take_a_tab_to_the_web() {
        let (browser, _, _) = browser();
        assert!(
            browser
                .open(Some("file:///etc/passwd"), Profile::Agent, true)
                .is_err()
        );
        let tab = browser
            .open(Some("https://a.test"), Profile::Agent, true)
            .unwrap();
        assert!(
            browser
                .navigate(tab.id, "file:///etc/passwd", true)
                .is_err()
        );
        assert!(browser.navigate(tab.id, "b.test", true).is_ok());
        // The developer may.
        assert!(
            browser
                .navigate(tab.id, "file:///tmp/page.html", false)
                .is_ok()
        );
    }

    #[test]
    fn a_page_cannot_take_the_tab_anywhere_but_the_web() {
        let (browser, _, _) = browser();
        open(&browser, "a.test");
        for allowed in [
            "https://b.test/",
            "http://localhost:3000/x",
            "about:blank",
            "file:///tmp/a.html",
        ] {
            assert!(browser.navigating(1, allowed), "{allowed}");
        }
        for refused in [
            "tauri://localhost/",
            "ipc://localhost/x",
            "asset://localhost/x",
            "javascript:alert(1)",
            "zoommtg://join",
            "about:srcdoc",
            "mailto:a@b.c",
        ] {
            assert!(!browser.navigating(1, refused), "{refused}");
        }
    }

    #[test]
    fn a_new_window_a_page_asks_for_is_a_tab_of_the_same_kind() {
        let (browser, _, _) = browser();
        let own = browser.open(Some("a.test"), Profile::Agent, true).unwrap();
        browser.popup(own.id, "https://b.test/popup");
        let tabs = browser.tabs();
        assert_eq!(tabs.len(), 2);
        assert_eq!(
            (tabs[1].profile, tabs[1].agent_control),
            (Profile::Agent, true)
        );
        let dev = open(&browser, "c.test");
        browser.popup(dev.id, "https://d.test/");
        let last = browser.tabs().pop().unwrap();
        assert_eq!((last.profile, last.agent_control), (Profile::User, false));
    }

    #[test]
    fn an_agents_tab_does_not_take_the_screen_from_a_tab_the_developer_is_using() {
        let (browser, _, _) = browser();
        browser.set_bounds(Rect {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        });
        browser.set_visible(true);
        let own = open(&browser, "mine.test");
        let agents = browser
            .open(Some("https://agent.test"), Profile::Agent, true)
            .unwrap();
        assert_eq!(browser.active(), Some(own.id));
        assert_ne!(browser.active(), Some(agents.id));
        // Nothing is on screen: the agent's tab is waiting when the developer comes.
        browser.set_visible(false);
        let later = browser
            .open(Some("https://later.test"), Profile::Agent, true)
            .unwrap();
        assert_eq!(browser.active(), Some(later.id));
    }

    #[test]
    fn what_an_agent_may_reach_is_what_it_opened_or_was_given() {
        let (browser, _, _) = browser();
        let session = SessionId::new();
        assert!(
            browser
                .agent_tab(session, None)
                .unwrap_err()
                .message
                .contains("open one with browser_tabs")
        );
        let own = open(&browser, "mine.test");
        let error = browser
            .agent_tab(session, Some(own.id))
            .unwrap_err()
            .message;
        assert!(
            error.contains("not shared with you") && error.contains("Agent control"),
            "{error}"
        );
        assert!(
            browser.agent_tab(session, None).is_err(),
            "a tab of the developer's is not a default"
        );
        let theirs = browser
            .open(Some("https://agent.test"), Profile::Agent, true)
            .unwrap();
        assert_eq!(
            browser.agent_tab(session, None).unwrap(),
            theirs.id,
            "the only tab it can use"
        );
        assert_eq!(
            browser.agent_tab(session, Some(theirs.id)).unwrap(),
            theirs.id
        );
        assert!(
            browser
                .agent_tab(session, Some(99))
                .unwrap_err()
                .message
                .contains("no tab 99")
        );
        // The developer hands a tab over; with two, the agent has to say which, or has a current one.
        browser.set_agent_control(own.id, true).unwrap();
        assert!(
            browser
                .agent_tab(session, None)
                .unwrap_err()
                .message
                .contains("which tab?")
        );
        browser.remember_current(session, own.id);
        assert_eq!(browser.agent_tab(session, None).unwrap(), own.id);
        // And takes it back: the agent no longer has it, nor a current one that was it.
        browser.set_agent_control(own.id, false).unwrap();
        assert!(browser.agent_tab(session, Some(own.id)).is_err());
        assert_eq!(browser.agent_tab(session, None).unwrap(), theirs.id);
        assert!(browser.set_agent_control(99, true).is_err());
    }

    #[test]
    fn the_master_switch_shuts_agents_out_of_every_tab() {
        let (browser, _, _) = browser();
        let session = SessionId::new();
        let theirs = browser
            .open(Some("https://agent.test"), Profile::Agent, true)
            .unwrap();
        browser.set_agents_allowed(false);
        let error = browser
            .agent_tab(session, Some(theirs.id))
            .unwrap_err()
            .message;
        assert!(
            error.contains("switched agent control of the browser off"),
            "{error}"
        );
        browser.set_agents_allowed(true);
        assert!(browser.agent_tab(session, Some(theirs.id)).is_ok());
    }

    fn answered(scripted: &'static str) -> impl Fn(TabId, &str) -> Result<String> + Send + Sync {
        move |_, _| text(serde_json::from_str(scripted).unwrap())
    }

    #[test]
    fn a_command_that_answers_at_once_returns_its_value() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        engine.answer(answered(
            r#"{"done":true,"value":{"clicked":"button \"Go\""}}"#,
        ));
        let outcome = browser
            .command(
                1,
                &json!({"op": "click", "target": {"ref": "e1"}}),
                None,
                false,
            )
            .unwrap();
        assert_eq!(outcome, Outcome::Done(json!({"clicked": "button \"Go\""})));
        let sent = engine
            .log()
            .into_iter()
            .find(|call| call.contains("__ataraxia.run"))
            .unwrap();
        assert!(sent.contains(r#""op":"click""#) && sent.contains("window.__ataraxia ?"));
    }

    #[test]
    fn a_command_that_has_to_wait_is_followed_until_it_is_done() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        let polls = Arc::new(AtomicU32::new(0));
        let counted = Arc::clone(&polls);
        engine.answer(move |_, script| {
            if script.contains("__ataraxia.poll") {
                let n = counted.fetch_add(1, Ordering::SeqCst);
                if n < 2 {
                    text(json!({"done": false}))
                } else {
                    text(json!({"done": true, "value": {"waited": 80}}))
                }
            } else {
                text(json!({"pending": true}))
            }
        });
        let outcome = browser
            .command(1, &json!({"op": "wait", "ms": 80}), None, false)
            .unwrap();
        assert_eq!(outcome, Outcome::Done(json!({"waited": 80})));
        assert_eq!(polls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn an_error_in_the_page_is_an_error_with_its_words() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        engine.answer(answered(
            r#"{"done":true,"error":"2 elements match .x: use a ref"}"#,
        ));
        let error = browser
            .command(1, &json!({"op": "click"}), None, false)
            .unwrap_err();
        assert_eq!(error.message, "2 elements match .x: use a ref");
    }

    #[test]
    fn a_page_that_goes_away_during_a_command_is_reported_as_navigated() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        engine.answer(|_, script| {
            if script.contains("__ataraxia.poll") {
                text(json!({"gone": true}))
            } else {
                text(json!({"pending": true}))
            }
        });
        assert_eq!(
            browser
                .command(1, &json!({"op": "click"}), None, false)
                .unwrap(),
            Outcome::Navigated
        );
    }

    #[test]
    fn a_page_without_the_bridge_is_waited_for_and_then_given_up_on() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        let asked = Arc::new(AtomicU32::new(0));
        let count = Arc::clone(&asked);
        engine.answer(move |_, _| {
            if count.fetch_add(1, Ordering::SeqCst) < 2 {
                text(json!({"missing": true}))
            } else {
                text(json!({"done": true, "value": 1}))
            }
        });
        assert_eq!(
            browser
                .command(1, &json!({"op": "snapshot"}), None, false)
                .unwrap(),
            Outcome::Done(json!(1))
        );
        assert_eq!(asked.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_command_that_never_finishes_times_out_and_a_tab_taken_back_stops_it() {
        let (browser, engine, _) = browser();
        let tab = browser
            .open(Some("https://a.test"), Profile::Agent, true)
            .unwrap();
        engine.answer(|_, _| text(json!({"pending": true})));
        let timed_out = browser
            .command(
                tab.id,
                &json!({"op": "wait"}),
                Some(Duration::from_millis(120)),
                true,
            )
            .unwrap_err();
        assert!(
            timed_out.message.contains("did not finish"),
            "{}",
            timed_out.message
        );
        // The developer takes control while the command runs.
        let taker = {
            let browser = Arc::clone(&browser);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(60));
                browser.set_agent_control(tab.id, false).unwrap();
            })
        };
        let error = browser
            .command(
                tab.id,
                &json!({"op": "wait"}),
                Some(Duration::from_secs(10)),
                true,
            )
            .unwrap_err();
        taker.join().unwrap();
        assert!(error.message.contains("took control"), "{}", error.message);
    }

    #[test]
    fn an_expression_is_run_in_the_script_the_platform_runs_and_not_through_eval() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        engine.answer(answered(r#"{"done":true,"value":[1,2]}"#));
        let outcome = browser
            .evaluate(1, "document.querySelectorAll('li').length", false)
            .unwrap();
        assert_eq!(outcome, Outcome::Done(json!([1, 2])));
        let sent = engine
            .log()
            .into_iter()
            .find(|call| call.contains("__ataraxia.exec"))
            .unwrap();
        assert!(
            sent.contains("(async () => (\\ndocument.querySelectorAll('li').length\\n))()")
                || sent.contains("document.querySelectorAll('li').length")
        );
        assert!(
            !sent.contains("eval("),
            "the page's own eval is never needed"
        );
    }

    #[test]
    fn what_a_page_logged_is_read_back_into_the_tab_and_counted() {
        let (browser, engine, events) = browser();
        open(&browser, "a.test");
        engine.answer(|_, script| {
            assert!(script.contains("__ataraxia.drain(0, \"\")"), "{script}");
            text(json!({
                "pageId": "p1", "cursor": 4,
                "console": [{"level": "error", "text": "bad", "t": 1, "page": "https://a.test/"}],
                "errors": [{"kind": "exception", "message": "boom"}],
                "net": [{"id": "n1", "kind": "fetch", "method": "GET", "url": "https://a.test/api", "status": 500, "done": true}],
                "meta": {"pageId": "p1", "url": "https://a.test/app/route", "title": "App", "readyState": "complete", "favicon": "https://a.test/i.png", "pending": 0}
            }))
        });
        browser.refresh(1).unwrap();
        let tab = browser.tabs().remove(0);
        assert_eq!((tab.errors, tab.failed_requests), (2, 1));
        assert_eq!(tab.title, "App");
        assert_eq!(
            tab.url, "https://a.test/app/route",
            "a page that moves on by itself is followed"
        );
        assert_eq!(tab.favicon.as_deref(), Some("https://a.test/i.png"));
        assert!(
            !tab.loading,
            "the page saying it is complete ends the loading"
        );
        assert_eq!(
            browser
                .logs(1, |logs| (logs.console.len(), logs.net.len()))
                .unwrap(),
            (1, 1)
        );
        assert!(matches!(
            events.lock().last(),
            Some(BrowserEvent::Tabs { .. })
        ));
        // The next read asks from where this one stopped.
        engine.answer(|_, script| {
            assert!(script.contains("__ataraxia.drain(4, \"p1\")"), "{script}");
            text(json!({"pageId": "p1", "cursor": 4, "meta": {"pageId": "p1"}}))
        });
        browser.refresh(1).unwrap();
        browser.clear_logs(1).unwrap();
        assert_eq!(browser.tabs()[0].errors, 0);
        assert!(browser.refresh(9).is_err());
    }

    #[test]
    fn the_old_page_saying_it_is_complete_does_not_end_a_load_only_a_new_one_does() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        let drain = |page: &'static str| {
            move |_: TabId, _: &str| {
                text(
                    json!({"pageId": page, "cursor": 1, "meta": {"pageId": page, "url": "https://a.test/", "readyState": "complete", "pending": 0}}),
                )
            }
        };
        engine.answer(drain("old"));
        browser.refresh(1).unwrap();
        browser.navigate(1, "https://b.test/", false).unwrap();
        assert!(browser.tab_loading(1));
        // The page that is still there answers: it is complete, but it is the old one.
        browser.refresh(1).unwrap();
        assert!(browser.tab_loading(1), "the load goes on");
        engine.answer(drain("new"));
        browser.refresh(1).unwrap();
        assert!(!browser.tab_loading(1));
        assert!(browser.wait_loaded(1, Duration::from_millis(10)));
    }

    #[test]
    fn a_navigation_that_never_replaces_the_page_is_given_up_on_with_a_reason() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        browser.set_load_give_up(Duration::from_millis(60));
        let old = |_: TabId, _: &str| {
            text(
                json!({"pageId": "old", "cursor": 1, "meta": {"pageId": "old", "url": "https://a.test/", "readyState": "complete", "pending": 0}}),
            )
        };
        engine.answer(old);
        browser.refresh(1).unwrap();
        browser.navigate(1, "http://blocked.test/", false).unwrap();
        browser.refresh(1).unwrap();
        assert!(browser.tab_loading(1), "not yet: it may only be slow");
        std::thread::sleep(Duration::from_millis(80));
        browser.refresh(1).unwrap();
        assert!(!browser.tab_loading(1));
        let tab = browser.tabs().remove(0);
        assert!(
            tab.load_error
                .as_deref()
                .is_some_and(|error| error.contains("did not load")),
            "{tab:?}"
        );
        // A new attempt clears it.
        browser.navigate(1, "https://ok.test/", false).unwrap();
        assert_eq!(browser.tabs()[0].load_error, None);
    }

    #[test]
    fn a_page_that_does_not_answer_is_asked_less_often() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        let asked = Arc::new(AtomicU32::new(0));
        let count = Arc::clone(&asked);
        engine.answer(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Err(Error::new(ErrorCode::Io, "no answer"))
        });
        for _ in 0..20 {
            browser.pump_once();
        }
        let asks = asked.load(Ordering::SeqCst);
        assert!((4..12).contains(&asks), "{asks}");
    }

    #[test]
    fn an_agent_is_told_what_changed_in_the_page_once() {
        let (browser, engine, _) = browser();
        let tab = browser
            .open(Some("https://a.test"), Profile::Agent, true)
            .unwrap();
        engine.answer(|_, _| {
            text(json!({
                "pageId": "p1", "cursor": 3,
                "console": [{"level": "error", "text": "bad"}, {"level": "log", "text": "fine"}],
                "net": [{"id": "n1", "kind": "xhr", "method": "GET", "url": "https://a.test/x", "status": 404, "done": true}],
                "meta": {"pageId": "p1", "url": "https://a.test/", "title": "Home", "readyState": "complete"}
            }))
        });
        let first = browser.changes_since_told(tab.id);
        assert!(
            first
                .iter()
                .any(|note| note.contains("\"Home\" https://a.test/")),
            "{first:?}"
        );
        assert!(
            first
                .iter()
                .any(|note| note.contains("1 new console error")),
            "{first:?}"
        );
        assert!(
            first
                .iter()
                .any(|note| note.contains("1 new failed request")),
            "{first:?}"
        );
        engine.answer(|_, _| text(json!({"pageId": "p1", "cursor": 3, "meta": {"pageId": "p1", "url": "https://a.test/", "title": "Home"}})));
        assert!(
            browser.changes_since_told(tab.id).is_empty(),
            "nothing is said twice"
        );
    }

    #[test]
    fn the_window_is_told_when_an_agent_works() {
        let (browser, _, events) = browser();
        browser.agent_activity(1, true, "click");
        assert_eq!(
            events.lock().last(),
            Some(&BrowserEvent::Agent {
                tab: 1,
                busy: true,
                action: "click".into()
            })
        );
    }

    #[test]
    fn cookies_and_screenshots_come_from_the_platform_for_the_tab() {
        let (browser, engine, _) = browser();
        open(&browser, "a.test");
        engine.cookies.lock().push(CookieInfo {
            name: "sid".into(),
            value: "1".into(),
            domain: None,
            path: None,
            secure: true,
            http_only: true,
            same_site: None,
            expires: None,
        });
        assert_eq!(browser.cookies(1).unwrap()[0].name, "sid");
        assert!(browser.cookies(9).is_err());
        assert_eq!(browser.screenshot(1, None).unwrap()[1..4], *b"PNG");
        assert!(engine.log().contains(&"screenshot 1 None".to_string()));
        browser.clear_data(Profile::Agent).unwrap();
        browser.devtools(1).unwrap();
        assert!(
            engine.log().contains(&"clear Agent".to_string())
                && engine.log().contains(&"devtools 1".to_string())
        );
    }
}
