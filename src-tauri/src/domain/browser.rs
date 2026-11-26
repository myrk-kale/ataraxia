//! The built-in browser: its tabs, what pages log, and the pure rules around them (addresses,
//! history, filters over the requests a page made, and how a request is turned into a `curl`).

use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Error, ErrorCode, Result};

pub type TabId = u32;

/// Which store of cookies and site data a tab uses. What an agent opens is kept apart from what the
/// developer browses, so an agent never starts with the developer's logged-in sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    User,
    Agent,
}

/// A tab, as the window shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: TabId,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub favicon: Option<String>,
    pub profile: Profile,
    /// Whether an agent may look at and act on this tab. Tabs an agent opens have it; the
    /// developer's own tabs only when they hand it over.
    pub agent_control: bool,
    /// Console errors and exceptions logged since the log was last cleared.
    pub errors: u32,
    /// Requests that failed or answered 4xx/5xx since the log was last cleared.
    pub failed_requests: u32,
    /// Why the page did not load, when it did not (blocked, offline, or too slow).
    #[serde(default)]
    pub load_error: Option<String>,
}

/// What the window is told as things happen.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BrowserEvent {
    /// The tabs changed (opened, closed, navigated, titled, counted...).
    #[serde(rename_all = "camelCase")]
    Tabs {
        tabs: Vec<BrowserTab>,
        active: Option<TabId>,
    },
    /// An agent is doing something in a tab (`busy`), or has just stopped.
    #[serde(rename_all = "camelCase")]
    Agent {
        tab: TabId,
        busy: bool,
        /// What it is doing, in a few words ("click", "open a tab").
        action: String,
    },
}

/// A rectangle in logical pixels, relative to the window's content.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn is_usable(&self) -> bool {
        self.width >= 1.0 && self.height >= 1.0 && self.x.is_finite() && self.y.is_finite()
    }
}

/// Where a tab's page is drawn.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Placement {
    /// On screen, where the browser's view is.
    Visible(Rect),
    /// Out of sight but alive and laid out at this size, so a page an agent works on in the
    /// background keeps rendering and can be photographed.
    Parked { width: f64, height: f64 },
}

/// The size a page is laid out at when the browser's view is not on screen.
pub const DEFAULT_VIEW: (f64, f64) = (1280.0, 800.0);

// ------------------------------------------------------------------ addresses

/// What the address bar does with what was typed: an address, or a search.
pub fn normalize_url(input: &str) -> Result<String> {
    let text = input.trim();
    if text.is_empty() {
        return Err(Error::new(ErrorCode::Invalid, "there is no address"));
    }
    if text == "about:blank" {
        return Ok(text.to_string());
    }
    let refused = |what: &str| {
        Err(Error::new(
            ErrorCode::Invalid,
            format!("addresses that start with {what} are not opened here"),
        ))
    };
    let lower = text.to_ascii_lowercase();
    for scheme in [
        "javascript:",
        "data:",
        "blob:",
        "view-source:",
        "vbscript:",
        "chrome:",
        "about:",
    ] {
        if lower.starts_with(scheme) {
            return refused(scheme);
        }
    }
    if let Some((scheme, _)) = text.split_once("://") {
        if !scheme.is_empty()
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')
        {
            return match scheme.to_ascii_lowercase().as_str() {
                "http" | "https" | "file" => url::Url::parse(text)
                    .map(|url| url.to_string())
                    .map_err(|_| Error::new(ErrorCode::Invalid, "that is not an address")),
                other => refused(&format!("{other}://")),
            };
        }
    }
    if !text.contains(char::is_whitespace) && looks_like_host(text) {
        let local = text.starts_with("localhost")
            || text.starts_with("127.")
            || text.starts_with("[::1]")
            || text.starts_with("0.0.0.0");
        let with_scheme = if local {
            format!("http://{text}")
        } else {
            format!("https://{text}")
        };
        if let Ok(url) = url::Url::parse(&with_scheme) {
            return Ok(url.to_string());
        }
    }
    let mut search = url::Url::parse("https://duckduckgo.com/").expect("a fixed address");
    search.query_pairs_mut().append_pair("q", text);
    Ok(search.to_string())
}

fn looks_like_host(text: &str) -> bool {
    let host = text.split(['/', '?', '#']).next().unwrap_or("");
    let name = host.rsplit_once('@').map_or(host, |(_, name)| name);
    let name = if name.starts_with('[') {
        name
    } else {
        name.rsplit_once(':')
            .filter(|(_, port)| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()))
            .map_or(name, |(name, _)| name)
    };
    name == "localhost"
        || name.starts_with('[')
        || (name.contains('.')
            && !name.starts_with('.')
            && !name.ends_with('.')
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
}

/// Where an agent may take a tab: web pages and the blank page. Files, scripts and data are not.
pub fn agent_may_open(url: &str) -> Result<()> {
    if url == "about:blank" {
        return Ok(());
    }
    match url::Url::parse(url) {
        Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => Ok(()),
        _ => Err(Error::new(
            ErrorCode::Invalid,
            "an agent can only open http and https addresses",
        )),
    }
}

// ------------------------------------------------------------------ history

/// Which way the tab was just told to move, so a navigation that follows is read as that move
/// and not as a new page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Move {
    Back,
    Forward,
    Reload,
}

/// The pages a tab has been through. The webview does not say whether it can go back, so the
/// browser keeps its own list, which is enough for the buttons.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct History {
    pages: Vec<String>,
    at: usize,
    expecting: Option<Move>,
}

impl History {
    pub fn new(first: &str) -> Self {
        Self {
            pages: vec![first.to_string()],
            at: 0,
            expecting: None,
        }
    }

    pub fn current(&self) -> Option<&str> {
        self.pages.get(self.at).map(String::as_str)
    }

    pub fn can_go_back(&self) -> bool {
        self.at > 0
    }

    pub fn can_go_forward(&self) -> bool {
        self.at + 1 < self.pages.len()
    }

    /// The tab is about to be told to move.
    pub fn expect(&mut self, movement: Move) {
        self.expecting = Some(movement);
    }

    /// The tab is at `url` (a navigation began, or the page changed its own address).
    pub fn observe(&mut self, url: &str) {
        let movement = self.expecting.take();
        if self.current() == Some(url) {
            return;
        }
        match movement {
            Some(Move::Back) if self.at > 0 => self.at -= 1,
            Some(Move::Forward) if self.can_go_forward() => self.at += 1,
            _ => {
                self.pages.truncate(self.at + 1);
                self.pages.push(url.to_string());
                self.at += 1;
                if self.pages.len() > 200 {
                    self.pages.remove(0);
                    self.at -= 1;
                }
            }
        }
        // A move that landed somewhere else (a redirect) is the page it is.
        if let Some(page) = self.pages.get_mut(self.at) {
            if page != url {
                *page = url.to_string();
            }
        }
    }
}

// ------------------------------------------------------------------ what pages log

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ConsoleEntry {
    /// Order of arrival in the tab, set by the app.
    pub seq: u64,
    pub level: String,
    pub text: String,
    pub t: i64,
    pub page: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PageError {
    pub seq: u64,
    pub kind: String,
    pub message: String,
    pub t: i64,
    pub page: String,
    pub source: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub stack: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Frame {
    pub d: String,
    pub t: i64,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NetEntry {
    pub id: String,
    /// fetch, xhr, ws, or resource (an image, a script... the page loaded by itself).
    pub kind: String,
    pub method: String,
    pub url: String,
    pub final_url: Option<String>,
    pub page: String,
    pub t: i64,
    pub status: u16,
    pub status_text: Option<String>,
    pub ok: Option<bool>,
    pub done: bool,
    pub duration: Option<u64>,
    pub req_headers: BTreeMap<String, String>,
    pub req_body: Option<String>,
    pub req_note: Option<String>,
    pub req_truncated: bool,
    pub res_headers: BTreeMap<String, String>,
    pub res_body: Option<String>,
    pub res_note: Option<String>,
    pub res_truncated: bool,
    pub res_size: Option<u64>,
    pub mime: Option<String>,
    pub error: Option<String>,
    pub initiator: Option<String>,
    pub frames: Vec<Frame>,
    pub close_code: Option<u16>,
    pub redirected: bool,
    /// Order the request was first seen in, set by the app.
    pub seq: u64,
}

impl NetEntry {
    /// Whether the request failed: it never answered, or the answer was an error.
    pub fn failed(&self) -> bool {
        if self.error.is_some() {
            return true;
        }
        if !self.done || self.kind == "ws" {
            return false;
        }
        if self.kind == "resource" {
            return self.status >= 400;
        }
        self.status >= 400 || self.status == 0
    }

    /// Whether the request is one the page's own code made, as opposed to a file it loaded.
    /// What it is called in listings: short, and unique across the pages of a tab.
    pub fn short_id(&self) -> String {
        format!("n{}", self.seq)
    }

    pub fn is_api_call(&self) -> bool {
        matches!(self.kind.as_str(), "fetch" | "xhr" | "ws")
    }
}

/// What a page sends back to be drained: the new and changed entries since the last time.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Drain {
    pub page_id: String,
    pub cursor: u64,
    pub console: Vec<ConsoleEntry>,
    pub errors: Vec<PageError>,
    pub net: Vec<NetEntry>,
    pub meta: Meta,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Meta {
    pub page_id: String,
    pub url: String,
    pub title: String,
    pub ready_state: String,
    pub favicon: String,
    pub pending: u32,
}

const CONSOLE_CAP: usize = 1000;
const ERROR_CAP: usize = 300;
const NET_CAP: usize = 800;

/// Everything a tab's pages have logged, across navigations.
#[derive(Debug, Default)]
pub struct Logs {
    pub console: VecDeque<ConsoleEntry>,
    pub errors: VecDeque<PageError>,
    pub net: VecDeque<NetEntry>,
    seq: u64,
    page_id: String,
    since: u64,
    /// Counted for the tab's badges: not reset by the ring buffers dropping old entries.
    error_count: u32,
    failed_ids: BTreeMap<String, bool>,
}

impl Logs {
    /// The page the next drain should be asked about, and from where.
    pub fn cursor(&self) -> (&str, u64) {
        (&self.page_id, self.since)
    }

    /// Merges what a page sent. Returns whether anything changed.
    pub fn apply(&mut self, drain: Drain) -> bool {
        if drain.page_id != self.page_id {
            self.page_id = drain.page_id.clone();
            self.since = 0;
        }
        self.since = self.since.max(drain.cursor);
        let mut changed = false;
        for mut entry in drain.console {
            self.seq += 1;
            entry.seq = self.seq;
            if entry.level == "error" {
                self.error_count += 1;
            }
            push_capped(&mut self.console, entry, CONSOLE_CAP);
            changed = true;
        }
        for mut entry in drain.errors {
            self.seq += 1;
            entry.seq = self.seq;
            self.error_count += 1;
            push_capped(&mut self.errors, entry, ERROR_CAP);
            changed = true;
        }
        for mut entry in drain.net {
            changed = true;
            let key = entry.id.clone();
            let failed = entry.failed();
            self.failed_ids.insert(key, failed);
            match self.net.iter_mut().find(|known| known.id == entry.id) {
                Some(known) => {
                    entry.seq = known.seq;
                    *known = entry;
                }
                None => {
                    self.seq += 1;
                    entry.seq = self.seq;
                    push_capped(&mut self.net, entry, NET_CAP);
                }
            }
        }
        changed
    }

    pub fn error_count(&self) -> u32 {
        self.error_count
    }

    pub fn failed_requests(&self) -> u32 {
        self.failed_ids.values().filter(|failed| **failed).count() as u32
    }

    pub fn clear(&mut self) {
        self.console.clear();
        self.errors.clear();
        self.net.clear();
        self.error_count = 0;
        self.failed_ids.clear();
    }

    /// The highest sequence number given so far: "what is new" is everything above it.
    pub fn mark(&self) -> u64 {
        self.seq
    }
}

fn push_capped<T>(list: &mut VecDeque<T>, entry: T, cap: usize) {
    list.push_back(entry);
    while list.len() > cap {
        list.pop_front();
    }
}

// ------------------------------------------------------------------ requests

/// Which requests to list.
#[derive(Debug, Clone, Default)]
pub struct NetFilter {
    /// Every kind, files the page loaded included. Without it only the page's own API calls and
    /// documents are listed.
    pub all: bool,
    pub text: Option<String>,
    pub method: Option<String>,
    /// `ok`, `failed`, `2xx`, `3xx`, `4xx`, `5xx`, or an exact status.
    pub status: Option<String>,
    pub kind: Option<String>,
    pub mime: Option<String>,
    /// Look into bodies as well as addresses.
    pub in_bodies: bool,
    pub after: u64,
}

impl NetFilter {
    pub fn matches(&self, entry: &NetEntry) -> bool {
        if self.after > 0 && entry.seq <= self.after {
            return false;
        }
        if !self.all && self.kind.is_none() && !entry.is_api_call() {
            return false;
        }
        if let Some(kind) = &self.kind {
            if !entry.kind.eq_ignore_ascii_case(kind) {
                return false;
            }
        }
        if let Some(method) = &self.method {
            if !entry.method.eq_ignore_ascii_case(method) {
                return false;
            }
        }
        if let Some(mime) = &self.mime {
            let have = entry.mime.as_deref().unwrap_or("").to_ascii_lowercase();
            if !have.contains(&mime.to_ascii_lowercase()) {
                return false;
            }
        }
        if let Some(status) = &self.status {
            let code = entry.status;
            let hit = match status.to_ascii_lowercase().as_str() {
                "failed" | "error" => entry.failed(),
                "ok" | "success" => entry.done && !entry.failed(),
                "pending" => !entry.done,
                "2xx" => (200..300).contains(&code),
                "3xx" => (300..400).contains(&code),
                "4xx" => (400..500).contains(&code),
                "5xx" => (500..600).contains(&code),
                exact => exact.parse::<u16>().is_ok_and(|wanted| wanted == code),
            };
            if !hit {
                return false;
            }
        }
        if let Some(text) = &self.text {
            let needle = text.to_ascii_lowercase();
            let in_url = entry.url.to_ascii_lowercase().contains(&needle);
            let in_bodies = self.in_bodies
                && [&entry.req_body, &entry.res_body].iter().any(|body| {
                    body.as_deref()
                        .is_some_and(|body| body.to_ascii_lowercase().contains(&needle))
                });
            if !in_url && !in_bodies {
                return false;
            }
        }
        true
    }
}

/// Headers whose value is a credential. Listings hide them unless asked not to.
pub fn is_secret_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        "authorization"
            | "proxy-authorization"
            | "cookie"
            | "set-cookie"
            | "x-api-key"
            | "api-key"
            | "x-auth-token"
            | "x-csrf-token"
            | "x-xsrf-token"
            | "x-access-token"
    ) || name.contains("token")
        || name.contains("secret")
        || name.contains("session")
}

pub const REDACTED: &str = "‹redacted›";

pub fn visible_headers(
    headers: &BTreeMap<String, String>,
    reveal: bool,
) -> BTreeMap<String, String> {
    headers
        .iter()
        .map(|(name, value)| {
            let shown = if !reveal && is_secret_header(name) {
                REDACTED.to_string()
            } else {
                value.clone()
            };
            (name.clone(), shown)
        })
        .collect()
}

/// `n12  POST 201 application/json 143ms 2.1KB  https://api.example.com/v1/items`
pub fn net_line(entry: &NetEntry) -> String {
    let status = if entry.status > 0 {
        entry.status.to_string()
    } else if entry.error.is_some() {
        "ERR".to_string()
    } else if !entry.done {
        "...".to_string()
    } else {
        "-".to_string()
    };
    let mut parts = vec![entry.short_id(), entry.method.clone(), status];
    if let Some(mime) = &entry.mime {
        if !mime.is_empty() {
            parts.push(mime.clone());
        }
    }
    if let Some(ms) = entry.duration {
        parts.push(format!("{ms}ms"));
    }
    if let Some(size) = entry.res_size.filter(|size| *size > 0) {
        parts.push(human_size(size));
    }
    parts.push(entry.url.clone());
    if let Some(error) = &entry.error {
        parts.push(format!("({error})"));
    }
    parts.join(" ")
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1_048_576 {
        format!("{:.1}MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes}B")
    }
}

fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// Headers the HTTP client sets by itself; sending them again only gets in the way.
fn is_automatic_header(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "content-length"
            | "connection"
            | "accept-encoding"
            | "origin"
            | "referer"
            | "user-agent"
            | "priority"
            | "te"
            | "upgrade-insecure-requests"
    ) || name.starts_with("sec-")
}

/// The request as a `curl` command. Credentials are left out for `$TOKEN`-style placeholders unless
/// `reveal` is set, so what an agent writes into a script does not carry the developer's session.
pub fn to_curl(entry: &NetEntry, reveal: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    if entry.method != "GET" {
        parts.push(format!("-X {}", entry.method));
    }
    for (name, value) in &entry.req_headers {
        if is_automatic_header(name) {
            continue;
        }
        let shown = if !reveal && is_secret_header(name) {
            format!("${{{}}}", name.to_ascii_uppercase().replace('-', "_"))
        } else {
            value.clone()
        };
        parts.push(format!("-H {}", shell_quote(&format!("{name}: {shown}"))));
    }
    if let Some(body) = entry.req_body.as_deref().filter(|body| !body.is_empty()) {
        parts.push(format!("--data-raw {}", shell_quote(body)));
    }
    parts.push("--compressed".to_string());
    // A placeholder in single quotes would not expand: a credential is quoted so that it does.
    let mut lines = vec![format!("curl {}", shell_quote(&entry.url))];
    lines.extend(parts.into_iter().map(|part| {
        if part.contains("${") && part.starts_with("-H '") {
            format!("-H \"{}\"", &part[4..part.len() - 1])
        } else {
            part
        }
    }));
    lines.join(" \\\n  ")
}

/// The request as a `fetch` call for a script.
pub fn to_fetch(entry: &NetEntry, reveal: bool) -> String {
    let mut headers = serde_json::Map::new();
    for (name, value) in &entry.req_headers {
        if is_automatic_header(name) {
            continue;
        }
        let shown = if !reveal && is_secret_header(name) {
            format!("<{}>", name)
        } else {
            value.clone()
        };
        headers.insert(name.clone(), json!(shown));
    }
    let mut options = serde_json::Map::new();
    options.insert("method".into(), json!(entry.method));
    if !headers.is_empty() {
        options.insert("headers".into(), Value::Object(headers));
    }
    if let Some(body) = entry.req_body.as_deref().filter(|body| !body.is_empty()) {
        options.insert("body".into(), json!(body));
    }
    format!(
        "const response = await fetch({}, {});\nconst data = await response.json();",
        json!(entry.url),
        serde_json::to_string_pretty(&Value::Object(options)).unwrap_or_default()
    )
}

/// A HAR 1.2 file of the requests, for tools that read one.
pub fn to_har(entries: &[&NetEntry], reveal: bool) -> Value {
    let list = |headers: &BTreeMap<String, String>| -> Vec<Value> {
        visible_headers(headers, reveal)
            .into_iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect()
    };
    json!({
        "log": {
            "version": "1.2",
            "creator": { "name": "Ataraxia", "version": env!("CARGO_PKG_VERSION") },
            "entries": entries.iter().map(|entry| json!({
                "startedDateTime": entry.t,
                "time": entry.duration.unwrap_or(0),
                "request": {
                    "method": entry.method,
                    "url": entry.url,
                    "httpVersion": "HTTP/1.1",
                    "headers": list(&entry.req_headers),
                    "queryString": url::Url::parse(&entry.url).map(|url| url.query_pairs().map(|(name, value)| json!({ "name": name, "value": value })).collect::<Vec<_>>()).unwrap_or_default(),
                    "cookies": [],
                    "headersSize": -1,
                    "bodySize": entry.req_body.as_ref().map_or(0, |body| body.len() as i64),
                    "postData": entry.req_body.as_ref().map(|body| json!({ "mimeType": entry.req_headers.get("content-type").cloned().unwrap_or_default(), "text": body })),
                },
                "response": {
                    "status": entry.status,
                    "statusText": entry.status_text.clone().unwrap_or_default(),
                    "httpVersion": "HTTP/1.1",
                    "headers": list(&entry.res_headers),
                    "cookies": [],
                    "content": { "size": entry.res_size.unwrap_or(0), "mimeType": entry.mime.clone().unwrap_or_default(), "text": entry.res_body.clone().unwrap_or_default() },
                    "redirectURL": "",
                    "headersSize": -1,
                    "bodySize": entry.res_size.unwrap_or(0),
                },
                "cache": {},
                "timings": { "send": 0, "wait": entry.duration.unwrap_or(0), "receive": 0 },
            })).collect::<Vec<_>>(),
        }
    })
}

/// The shape of a JSON text: its keys and the type of each value, one example from a list. It says
/// what an API returns without the cost of reading all of it.
pub fn json_shape(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    Some(shape(&value, 0))
}

fn shape(value: &Value, depth: usize) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(_) => "boolean".into(),
        Value::Number(_) => "number".into(),
        Value::String(text) => {
            if text.chars().count() > 40 {
                "string(long)".into()
            } else {
                "string".into()
            }
        }
        Value::Array(items) => match items.first() {
            None => "[]".into(),
            Some(first) if depth < 4 => format!("[{} × {}]", shape(first, depth + 1), items.len()),
            Some(_) => format!("[… × {}]", items.len()),
        },
        Value::Object(map) => {
            if depth >= 4 {
                return "{…}".into();
            }
            let fields: Vec<String> = map
                .iter()
                .take(40)
                .map(|(key, value)| format!("{key}: {}", shape(value, depth + 1)))
                .collect();
            let more = if map.len() > 40 { ", …" } else { "" };
            format!("{{ {}{more} }}", fields.join(", "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, method: &str, url: &str, status: u16) -> NetEntry {
        NetEntry {
            id: id.into(),
            seq: id.trim_start_matches('n').parse().unwrap_or(0),
            kind: "fetch".into(),
            method: method.into(),
            url: url.into(),
            status,
            done: true,
            ..NetEntry::default()
        }
    }

    #[test]
    fn what_is_typed_in_the_address_bar_becomes_an_address_or_a_search() {
        let cases = [
            ("https://example.com/a?b=1", "https://example.com/a?b=1"),
            ("example.com", "https://example.com/"),
            ("example.com/docs", "https://example.com/docs"),
            ("localhost:3000", "http://localhost:3000/"),
            ("localhost:3000/app?x=1", "http://localhost:3000/app?x=1"),
            ("127.0.0.1:8080", "http://127.0.0.1:8080/"),
            ("http://localhost", "http://localhost/"),
            ("about:blank", "about:blank"),
            ("  spaced.dev  ", "https://spaced.dev/"),
        ];
        for (typed, expected) in cases {
            assert_eq!(normalize_url(typed).unwrap(), expected, "{typed}");
        }
        assert_eq!(
            normalize_url("how to center a div").unwrap(),
            "https://duckduckgo.com/?q=how+to+center+a+div"
        );
        assert_eq!(
            normalize_url("rust").unwrap(),
            "https://duckduckgo.com/?q=rust"
        );
        assert!(normalize_url("").is_err());
        assert!(normalize_url("   ").is_err());
    }

    #[test]
    fn scripts_data_and_the_like_are_never_opened() {
        for bad in [
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "blob:https://x/1",
            "view-source:https://x",
            "chrome://settings",
            "ftp://example.com",
        ] {
            assert!(normalize_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn an_agent_may_open_web_pages_and_the_blank_page_only() {
        assert!(agent_may_open("https://example.com").is_ok());
        assert!(agent_may_open("http://localhost:3000/x").is_ok());
        assert!(agent_may_open("about:blank").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:1",
            "data:text/plain,hi",
            "ftp://x",
            "not a url",
        ] {
            assert!(agent_may_open(bad).is_err(), "{bad}");
        }
        // The developer may open a file; only the address bar says so.
        assert!(normalize_url("file:///tmp/page.html").is_ok());
    }

    #[test]
    fn history_goes_back_and_forward_and_forgets_what_a_new_page_cuts_off() {
        let mut history = History::new("https://a.test/");
        assert!(!history.can_go_back() && !history.can_go_forward());
        history.observe("https://b.test/");
        history.observe("https://c.test/");
        assert!(history.can_go_back() && !history.can_go_forward());
        history.expect(Move::Back);
        history.observe("https://b.test/");
        assert_eq!(history.current(), Some("https://b.test/"));
        assert!(history.can_go_back() && history.can_go_forward());
        history.expect(Move::Forward);
        history.observe("https://c.test/");
        assert_eq!(history.current(), Some("https://c.test/"));
        history.expect(Move::Back);
        history.observe("https://b.test/");
        // A new page from here drops what was ahead.
        history.observe("https://d.test/");
        assert!(!history.can_go_forward());
        assert_eq!(history.current(), Some("https://d.test/"));
    }

    #[test]
    fn a_reload_or_the_same_address_changes_nothing_and_a_redirect_is_the_page_it_is() {
        let mut history = History::new("https://a.test/");
        history.expect(Move::Reload);
        history.observe("https://a.test/");
        history.observe("https://a.test/");
        assert!(!history.can_go_back());
        history.observe("https://b.test/");
        history.expect(Move::Back);
        // Going back landed somewhere else (the page redirected): that is where the tab is.
        history.observe("https://a.test/login");
        assert_eq!(history.current(), Some("https://a.test/login"));
        assert!(!history.can_go_back());
    }

    #[test]
    fn history_is_bounded() {
        let mut history = History::new("https://0.test/");
        for index in 1..260 {
            history.observe(&format!("https://{index}.test/"));
        }
        assert_eq!(history.current(), Some("https://259.test/"));
        assert!(history.can_go_back());
    }

    #[test]
    fn logs_merge_what_pages_send_keep_going_across_pages_and_count_the_bad() {
        let mut logs = Logs::default();
        let first = Drain {
            page_id: "p1".into(),
            cursor: 5,
            console: vec![
                ConsoleEntry {
                    level: "log".into(),
                    text: "hi".into(),
                    ..ConsoleEntry::default()
                },
                ConsoleEntry {
                    level: "error".into(),
                    text: "bad".into(),
                    ..ConsoleEntry::default()
                },
            ],
            errors: vec![PageError {
                kind: "exception".into(),
                message: "boom".into(),
                ..PageError::default()
            }],
            net: vec![
                entry("n1", "GET", "https://a.test/ok", 200),
                entry("n2", "GET", "https://a.test/gone", 404),
            ],
            ..Drain::default()
        };
        assert!(logs.apply(first));
        assert_eq!(logs.cursor(), ("p1", 5));
        assert_eq!(logs.error_count(), 2);
        assert_eq!(logs.failed_requests(), 1);
        // The same page, later: a request finishes (changed), another begins.
        let mut finished = entry("n3", "POST", "https://a.test/save", 0);
        finished.done = false;
        let later = Drain {
            page_id: "p1".into(),
            cursor: 9,
            net: vec![finished.clone()],
            ..Drain::default()
        };
        logs.apply(later);
        finished.done = true;
        finished.status = 500;
        logs.apply(Drain {
            page_id: "p1".into(),
            cursor: 12,
            net: vec![finished],
            ..Drain::default()
        });
        assert_eq!(
            logs.net.len(),
            3,
            "an entry that changed is updated, not added again"
        );
        assert_eq!(logs.net[2].status, 500);
        assert_eq!(logs.net[2].seq, 6, "it keeps its place in the order");
        assert_eq!(logs.failed_requests(), 2);
        // A new page starts counting from the beginning: nothing is lost.
        logs.apply(Drain {
            page_id: "p2".into(),
            cursor: 2,
            console: vec![ConsoleEntry {
                level: "warn".into(),
                ..ConsoleEntry::default()
            }],
            ..Drain::default()
        });
        assert_eq!(logs.cursor(), ("p2", 2));
        assert_eq!(logs.console.len(), 3);
        assert!(!logs.apply(Drain {
            page_id: "p2".into(),
            cursor: 2,
            ..Drain::default()
        }));
        logs.clear();
        assert_eq!(
            (
                logs.console.len(),
                logs.error_count(),
                logs.failed_requests()
            ),
            (0, 0, 0)
        );
    }

    #[test]
    fn the_logs_are_bounded() {
        let mut logs = Logs::default();
        let console = (0..1500)
            .map(|n| ConsoleEntry {
                text: n.to_string(),
                level: "log".into(),
                ..ConsoleEntry::default()
            })
            .collect();
        logs.apply(Drain {
            page_id: "p".into(),
            cursor: 1500,
            console,
            ..Drain::default()
        });
        assert_eq!(logs.console.len(), 1000);
        assert_eq!(logs.console.front().unwrap().text, "500");
        assert_eq!(logs.mark(), 1500);
    }

    #[test]
    fn requests_are_filtered_by_what_matters_to_the_caller() {
        let mut api = entry("n1", "POST", "https://api.test/v1/items", 201);
        api.mime = Some("application/json".into());
        api.res_body = Some(r#"{"order":"A-1001"}"#.into());
        let mut asset = entry("n2", "GET", "https://cdn.test/app.js", 200);
        asset.kind = "resource".into();
        let missing = entry("n3", "GET", "https://api.test/v1/missing", 404);
        let mut broken = entry("n4", "GET", "https://api.test/v1/down", 0);
        broken.error = Some("Failed to fetch".into());
        let mut pending = entry("n5", "GET", "https://api.test/v1/slow", 0);
        pending.done = false;
        let all = [&api, &asset, &missing, &broken, &pending];
        let pick = |filter: NetFilter| -> Vec<&str> {
            all.iter()
                .filter(|e| filter.matches(e))
                .map(|e| e.id.as_str())
                .collect()
        };

        assert_eq!(
            pick(NetFilter::default()),
            ["n1", "n3", "n4", "n5"],
            "files the page loaded are left out"
        );
        assert_eq!(
            pick(NetFilter {
                all: true,
                ..NetFilter::default()
            }),
            ["n1", "n2", "n3", "n4", "n5"]
        );
        assert_eq!(
            pick(NetFilter {
                status: Some("failed".into()),
                ..NetFilter::default()
            }),
            ["n3", "n4"]
        );
        assert_eq!(
            pick(NetFilter {
                status: Some("2xx".into()),
                ..NetFilter::default()
            }),
            ["n1"]
        );
        assert_eq!(
            pick(NetFilter {
                status: Some("404".into()),
                ..NetFilter::default()
            }),
            ["n3"]
        );
        assert_eq!(
            pick(NetFilter {
                status: Some("pending".into()),
                ..NetFilter::default()
            }),
            ["n5"]
        );
        assert_eq!(
            pick(NetFilter {
                method: Some("post".into()),
                ..NetFilter::default()
            }),
            ["n1"]
        );
        assert_eq!(
            pick(NetFilter {
                text: Some("V1/ITEMS".into()),
                ..NetFilter::default()
            }),
            ["n1"]
        );
        assert_eq!(
            pick(NetFilter {
                mime: Some("json".into()),
                ..NetFilter::default()
            }),
            ["n1"]
        );
        assert_eq!(
            pick(NetFilter {
                kind: Some("resource".into()),
                ..NetFilter::default()
            }),
            ["n2"]
        );
        // A value can be looked for in the bodies, which is how the call behind it is found.
        assert!(
            pick(NetFilter {
                text: Some("a-1001".into()),
                ..NetFilter::default()
            })
            .is_empty()
        );
        assert_eq!(
            pick(NetFilter {
                text: Some("a-1001".into()),
                in_bodies: true,
                ..NetFilter::default()
            }),
            ["n1"]
        );
        let mut seen = api.clone();
        seen.seq = 7;
        assert!(
            !NetFilter {
                after: 7,
                ..NetFilter::default()
            }
            .matches(&seen)
        );
    }

    #[test]
    fn secrets_are_hidden_unless_asked_for() {
        let headers: BTreeMap<String, String> = [
            ("authorization", "Bearer abc"),
            ("cookie", "sid=1"),
            ("x-custom-token", "t"),
            ("content-type", "application/json"),
            ("accept", "*/*"),
        ]
        .into_iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
        let hidden = visible_headers(&headers, false);
        assert_eq!(hidden["authorization"], REDACTED);
        assert_eq!(hidden["cookie"], REDACTED);
        assert_eq!(hidden["x-custom-token"], REDACTED);
        assert_eq!(hidden["content-type"], "application/json");
        assert_eq!(
            visible_headers(&headers, true)["authorization"],
            "Bearer abc"
        );
    }

    #[test]
    fn a_request_becomes_a_curl_that_keeps_what_matters_and_leaves_credentials_out() {
        let mut request = entry("n1", "POST", "https://api.test/v1/items?x=1", 201);
        request.req_headers = [
            ("authorization", "Bearer abc"),
            ("content-type", "application/json"),
            ("user-agent", "Mozilla"),
            ("sec-fetch-mode", "cors"),
            ("content-length", "9"),
        ]
        .into_iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
        request.req_body = Some(r#"{"name":"it's"}"#.into());
        let safe = to_curl(&request, false);
        assert!(safe.starts_with("curl 'https://api.test/v1/items?x=1'"));
        assert!(safe.contains("-X POST"));
        assert!(safe.contains("-H 'content-type: application/json'"));
        assert!(
            safe.contains("-H \"authorization: ${AUTHORIZATION}\""),
            "{safe}"
        );
        assert!(!safe.contains("Bearer abc"));
        assert!(
            !safe.contains("user-agent")
                && !safe.contains("sec-fetch")
                && !safe.contains("content-length")
        );
        assert!(
            safe.contains(r#"--data-raw '{"name":"it'\''s"}'"#),
            "{safe}"
        );
        let revealed = to_curl(&request, true);
        assert!(revealed.contains("authorization: Bearer abc"));
        let get = entry("n2", "GET", "https://api.test/", 200);
        assert!(!to_curl(&get, false).contains("-X"));
    }

    #[test]
    fn a_request_becomes_a_fetch_call_and_a_har_entry() {
        let mut request = entry("n1", "POST", "https://api.test/v1/items", 201);
        request.req_headers = [
            ("authorization".to_string(), "Bearer abc".to_string()),
            ("content-type".to_string(), "application/json".to_string()),
        ]
        .into_iter()
        .collect();
        request.req_body = Some("{}".into());
        request.res_body = Some(r#"{"id":1}"#.into());
        request.mime = Some("application/json".into());
        let call = to_fetch(&request, false);
        assert!(call.contains(r#"fetch("https://api.test/v1/items""#));
        assert!(call.contains(r#""method": "POST""#));
        assert!(call.contains("<authorization>") && !call.contains("Bearer abc"));
        let har = to_har(&[&request], false);
        assert_eq!(har["log"]["version"], "1.2");
        let first = &har["log"]["entries"][0];
        assert_eq!(first["request"]["method"], "POST");
        assert_eq!(first["response"]["status"], 201);
        assert_eq!(first["response"]["content"]["text"], r#"{"id":1}"#);
        assert!(first["request"]["headers"].to_string().contains(REDACTED));
    }

    #[test]
    fn the_listing_line_says_what_a_request_was_and_how_it_went() {
        let mut request = entry("n7", "GET", "https://api.test/v1/items", 200);
        request.mime = Some("application/json".into());
        request.duration = Some(143);
        request.res_size = Some(2150);
        assert_eq!(
            net_line(&request),
            "n7 GET 200 application/json 143ms 2.1KB https://api.test/v1/items"
        );
        let mut failed = entry("n8", "GET", "https://api.test/x", 0);
        failed.error = Some("Failed to fetch".into());
        assert_eq!(
            net_line(&failed),
            "n8 GET ERR https://api.test/x (Failed to fetch)"
        );
        let mut pending = entry("n9", "GET", "https://api.test/y", 0);
        pending.done = false;
        assert!(net_line(&pending).contains(" ... "));
    }

    #[test]
    fn a_json_body_is_summed_up_by_its_shape() {
        let shape = json_shape(r#"{"items":[{"id":1,"name":"a","tags":["x"]},{"id":2}],"next":null,"ok":true,"note":"this is a rather long piece of text that goes on"}"#).unwrap();
        assert_eq!(
            shape,
            "{ items: [{ id: number, name: string, tags: [string × 1] } × 2], next: null, note: string(long), ok: boolean }"
        );
        assert_eq!(json_shape("[]").unwrap(), "[]");
        assert!(json_shape("not json").is_none());
    }

    #[test]
    fn events_and_tabs_are_sent_to_the_window_in_camel_case() {
        let tab = BrowserTab {
            id: 1,
            url: "https://a.test/".into(),
            title: "A".into(),
            loading: false,
            can_go_back: true,
            can_go_forward: false,
            favicon: None,
            profile: Profile::Agent,
            agent_control: true,
            errors: 2,
            failed_requests: 1,
            load_error: None,
        };
        let event = serde_json::to_value(BrowserEvent::Tabs {
            tabs: vec![tab],
            active: Some(1),
        })
        .unwrap();
        assert_eq!(event["type"], "tabs");
        assert_eq!(event["tabs"][0]["canGoBack"], true);
        assert_eq!(event["tabs"][0]["agentControl"], true);
        assert_eq!(event["tabs"][0]["profile"], "agent");
        let busy = serde_json::to_value(BrowserEvent::Agent {
            tab: 1,
            busy: true,
            action: "click".into(),
        })
        .unwrap();
        assert_eq!(
            busy,
            json!({"type": "agent", "tab": 1, "busy": true, "action": "click"})
        );
    }
}
