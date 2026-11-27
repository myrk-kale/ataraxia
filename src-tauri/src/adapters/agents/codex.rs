//! Codex through `codex app-server` (JSON-RPC over stdio, without the `jsonrpc` member).
//!
//! A thread is opened with `thread/start`; each prompt is a `turn/start`. Progress arrives as
//! `item/*` and `turn/*` notifications; command and file-change approvals arrive as server
//! requests answered with a `decision`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::backend::{
    AgentBackend, BackendContext, BackendEvent, BackendSession, Emitter, ImageFile, Launch,
    SubagentRoute, api_env, compose_env, profile_args, profile_program, split_command,
    truncate_output,
};
use super::config::prepare_isolated_home;
use super::definitions::codex_agents;
use super::process::{ExitInfo, SpawnSpec, resolve_binary};
use super::rpc::{Incoming, RpcClient};
use crate::domain::agent::{ModelChoice, SessionOptions};
use crate::domain::ids::TurnId;
use crate::domain::{
    Error, ErrorCode, PermissionDecision, PermissionRequestId, Result, SubagentUpdate, ToolCallId,
    UsageWindow, UsageWindowKind,
};

const BINARY_NAME: &str = "codex";
const OVERRIDE_ENV: &str = "ATARAXIA_CODEX_BIN";
const APPROVALS_REVIEWER_ENV: &str = "ATARAXIA_CODEX_APPROVALS_REVIEWER";
const DEFAULT_APPROVALS_REVIEWER: &str = "auto_review";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
/// Asking for the limits goes to the account's server; it is not worth waiting long for.
const USAGE_TIMEOUT: Duration = Duration::from_secs(20);
const INTERRUPT_TIMEOUT: Duration = Duration::from_secs(10);
const COMMANDS_TIMEOUT: Duration = Duration::from_secs(10);

const COMMAND_APPROVAL: &str = "item/commandExecution/requestApproval";
const FILE_CHANGE_APPROVAL: &str = "item/fileChange/requestApproval";

enum Launcher {
    Resolve,
    Fixed { program: PathBuf, args: Vec<String> },
}

pub struct CodexBackend {
    launcher: Launcher,
}

impl CodexBackend {
    pub fn new() -> Self {
        Self {
            launcher: Launcher::Resolve,
        }
    }

    /// Runs a stand-in program that speaks the same frames (tests).
    pub fn with_command(program: PathBuf, args: Vec<String>) -> Self {
        Self {
            launcher: Launcher::Fixed { program, args },
        }
    }

    fn command(
        &self,
        launch: Option<&Launch>,
    ) -> std::result::Result<(PathBuf, Vec<String>), String> {
        match &self.launcher {
            Launcher::Fixed { program, args } => Ok((program.clone(), args.clone())),
            Launcher::Resolve => {
                profile_program(launch, || resolve_binary(BINARY_NAME, OVERRIDE_ENV))
                    .map(|program| {
                        (
                            program,
                            profile_args(launch, vec!["app-server".to_string()]),
                        )
                    })
                    .ok_or_else(|| {
                        format!(
                            "codex CLI not found. Install it or set {OVERRIDE_ENV} to its path."
                        )
                    })
            }
        }
    }
}

/// Who reviews approval requests: `auto_review` (a reviewer agent decides, the default) or
/// `user` (every request reaches the modal). `ATARAXIA_CODEX_APPROVALS_REVIEWER` overrides it;
/// an empty value defers to the user's own Codex config.
fn approvals_reviewer() -> Option<String> {
    match std::env::var(APPROVALS_REVIEWER_ENV) {
        Ok(value) if value.trim().is_empty() => None,
        Ok(value) => Some(value.trim().to_string()),
        Err(_) => Some(DEFAULT_APPROVALS_REVIEWER.to_string()),
    }
}

/// `network`: the agent has Ataraxia's local API to call. Codex's `workspace-write` sandbox cuts
/// every connection, localhost included, so without it each `curl` to the API fails.
fn thread_start_params(
    cwd: &Path,
    reviewer: Option<&str>,
    model: Option<&str>,
    read_only: bool,
    extra_dirs: &[PathBuf],
    network: bool,
) -> Value {
    let mut params = json!({
        "cwd": cwd.to_string_lossy(),
        "approvalPolicy": "on-request",
        "sandbox": if read_only { "read-only" } else { "workspace-write" }
    });
    if let Some(reviewer) = reviewer {
        params["approvalsReviewer"] = json!(reviewer);
    }
    if let Some(model) = model {
        params["model"] = json!(model);
    }
    // Other repositories of the workspace may be written too. Reading is open already.
    let mut sandbox = serde_json::Map::new();
    if !read_only && !extra_dirs.is_empty() {
        let roots: Vec<String> = extra_dirs
            .iter()
            .map(|dir| dir.to_string_lossy().into_owned())
            .collect();
        sandbox.insert("writable_roots".into(), json!(roots));
    }
    if !read_only && network {
        sandbox.insert("network_access".into(), json!(true));
    }
    if !sandbox.is_empty() {
        params["config"] = json!({ "sandbox_workspace_write": sandbox });
    }
    params
}

#[cfg(test)]
pub(super) fn codex_mcp_servers_for_test(servers: &Map<String, Value>) -> Map<String, Value> {
    codex_mcp_servers(servers)
}

fn codex_mcp_servers(servers: &Map<String, Value>) -> Map<String, Value> {
    servers
        .iter()
        .map(|(name, server)| {
            let mut server = server.clone();
            if let Some(config) = server.as_object_mut() {
                if let Some(headers) = config.remove("headers") {
                    config.insert("http_headers".into(), headers);
                }
                // Codex tells a remote server from a local one by `url` against `command`; the
                // transport names other harnesses need are not part of its config.
                config.remove("type");
                config.remove("transport");
            }
            (name.clone(), server)
        })
        .collect()
}

impl Default for CodexBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentBackend for CodexBackend {
    fn availability(&self) -> std::result::Result<(), String> {
        self.command(None).map(|_| ())
    }

    fn start(&self, ctx: BackendContext) -> Result<Arc<dyn BackendSession>> {
        Ok(Arc::new(self.start_session(ctx)?))
    }
}

impl CodexBackend {
    fn start_session(&self, ctx: BackendContext) -> Result<CodexSession> {
        let (program, args) = self
            .command(ctx.launch.as_ref())
            .map_err(|message| Error::new(ErrorCode::Unsupported, message))?;
        let shared = Arc::new(CodexShared {
            me: OnceLock::new(),
            emit: ctx.emit,
            client: OnceLock::new(),
            thread_id: OnceLock::new(),
            exit: Mutex::new(None),
            state: Mutex::new(CodexState {
                model: ctx.model.clone(),
                effort: ctx.effort.clone(),
                agent: ctx.agent.clone(),
                ..CodexState::default()
            }),
        });
        let _ = shared.me.set(Arc::downgrade(&shared));
        let handler_shared = Arc::clone(&shared);
        let mut env = compose_env(
            api_env(ctx.session_id, ctx.api.as_ref()),
            ctx.launch.as_ref(),
        );
        let mcp_servers = codex_mcp_servers(&ctx.config.mcp_servers);
        let mut has_isolated_home = false;
        if let Some(config_path) = &ctx.config.mcp_config_path {
            if let Some(root) = config_path.parent() {
                let source_home = ctx
                    .launch
                    .as_ref()
                    .and_then(|launch| launch.env.iter().rev().find(|(key, _)| key == "CODEX_HOME"))
                    .map(|(_, value)| PathBuf::from(value))
                    .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
                    .or_else(|| {
                        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex"))
                    });
                let auth_file = source_home.map(|home| home.join("auth.json"));
                let isolated = prepare_isolated_home(
                    &root.join(ctx.session_id.0.to_string()).join("codex-home"),
                    auth_file.as_deref(),
                    &mcp_servers,
                )?;
                env.push(("CODEX_HOME".into(), isolated.to_string_lossy().into_owned()));
                has_isolated_home = true;
            }
        }
        let client = RpcClient::spawn(
            &SpawnSpec {
                program,
                args,
                cwd: ctx.cwd.clone(),
                env,
                env_remove: Vec::new(),
            },
            false,
            move |incoming| handler_shared.on_incoming(incoming),
        )?;
        let _ = shared.client.set(Arc::clone(&client));

        let mut resumed = false;
        let handshake = (|| -> Result<()> {
            client.request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "ataraxia",
                        "title": "Ataraxia",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
                Some(HANDSHAKE_TIMEOUT),
            )?;
            client.notify_bare("initialized")?;
            if !ctx.config.skill_roots.is_empty() {
                let roots: Vec<String> = ctx
                    .config
                    .skill_roots
                    .iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect();
                client.request(
                    "skills/extraRoots/set",
                    json!({ "extraRoots": roots }),
                    Some(COMMANDS_TIMEOUT),
                )?;
            }
            if has_isolated_home {
                restrict_codex_skills(&client, &ctx.cwd, &ctx.config.skills)?;
            }
            let mut params = thread_start_params(
                &ctx.cwd,
                approvals_reviewer().as_deref(),
                ctx.model.as_deref(),
                ctx.read_only,
                &ctx.extra_dirs,
                ctx.api.is_some(),
            );
            if !has_isolated_home {
                params["config"]["mcp_servers"] = json!(mcp_servers);
            }
            // The thread of the last run, if Codex still has it; a thread that never got a
            // message has nothing saved, and then a new one begins.
            if let Some(wanted) = ctx.resume.as_deref() {
                let mut resume = params.clone();
                resume["threadId"] = json!(wanted);
                // The history stays on Codex's side; the chat already shows it.
                resume["excludeTurns"] = json!(true);
                if client
                    .request("thread/resume", resume, Some(HANDSHAKE_TIMEOUT))
                    .is_ok()
                {
                    let _ = shared.thread_id.set(wanted.to_string());
                    resumed = true;
                    return Ok(());
                }
            }
            let started = client.request("thread/start", params, Some(HANDSHAKE_TIMEOUT))?;
            let thread_id = started
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    Error::new(ErrorCode::Agent, "thread/start returned no thread id")
                })?;
            let _ = shared.thread_id.set(thread_id.to_string());
            Ok(())
        })();
        if handshake.is_ok() {
            // Off the start-up path: the chat is usable before the account answers.
            let (asker, reader) = (Arc::clone(&shared), Arc::clone(&client));
            std::thread::spawn(move || {
                if let Ok(answer) =
                    reader.request("account/rateLimits/read", Value::Null, Some(USAGE_TIMEOUT))
                {
                    asker.report_usage(answer.get("rateLimits"));
                }
            });
        }
        if let Err(error) = handshake {
            let message = shared.with_exit_info(error.message);
            client.kill();
            return Err(Error::new(ErrorCode::Agent, message));
        }
        Ok(CodexSession {
            shared,
            cwd: ctx.cwd,
            models: OnceLock::new(),
            resumed,
        })
    }
}

/// Restricts Codex's process-wide skill catalog to the paths Ataraxia selected for this session.
/// Codex discovers system and project skills on its own, so adding Ataraxia roots alone is not an
/// allowlist. The isolated CODEX_HOME keeps these enablement rules out of the user's Codex config.
fn restrict_codex_skills(
    client: &RpcClient,
    cwd: &Path,
    selected: &[super::config::SkillDefinition],
) -> Result<()> {
    let selected_paths: HashSet<PathBuf> = selected
        .iter()
        .map(|skill| canonical_skill_path(&skill.path))
        .collect();
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let catalog = client.request(
        "skills/list",
        json!({ "cwds": [cwd.to_string_lossy()], "forceReload": true }),
        Some(COMMANDS_TIMEOUT),
    )?;
    let updates = codex_skill_updates(&catalog, &cwd, &selected_paths)?;
    for (path, enabled) in updates {
        let result = client.request(
            "skills/config/write",
            json!({ "path": path, "name": null, "enabled": enabled }),
            Some(COMMANDS_TIMEOUT),
        )?;
        if result.get("effectiveEnabled").and_then(Value::as_bool) != Some(enabled) {
            return Err(Error::new(
                ErrorCode::Agent,
                format!("Codex could not apply the Ataraxia skill selection for {path}"),
            ));
        }
    }
    Ok(())
}

fn canonical_skill_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn codex_skill_updates(
    catalog: &Value,
    cwd: &Path,
    selected_paths: &HashSet<PathBuf>,
) -> Result<Vec<(String, bool)>> {
    let data = catalog
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::new(ErrorCode::Agent, "Codex returned an invalid skill catalog"))?;
    let cwd = canonical_skill_path(cwd);
    let entry = data
        .iter()
        .find(|entry| {
            entry
                .get("cwd")
                .and_then(Value::as_str)
                .is_some_and(|path| canonical_skill_path(Path::new(path)) == cwd)
        })
        .ok_or_else(|| {
            Error::new(
                ErrorCode::Agent,
                "Codex returned no skill catalog for this workspace",
            )
        })?;
    let skills = entry
        .get("skills")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::new(ErrorCode::Agent, "Codex returned an invalid skill list"))?;
    let mut observed_selected = HashSet::new();
    let mut updates = Vec::new();
    for skill in skills {
        let path = skill
            .get("path")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| Error::new(ErrorCode::Agent, "Codex returned a skill without a path"))?;
        let selected = selected_paths.contains(&canonical_skill_path(Path::new(path)));
        if selected {
            observed_selected.insert(canonical_skill_path(Path::new(path)));
        }
        let enabled = skill
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if enabled != selected {
            updates.push((path.to_string(), selected));
        }
    }
    if &observed_selected != selected_paths {
        return Err(Error::new(
            ErrorCode::Agent,
            "Codex did not discover every skill selected by Ataraxia",
        ));
    }
    Ok(updates)
}

struct QueuedPermission {
    request_id: PermissionRequestId,
    turn_id: TurnId,
    rpc_id: Value,
    tool_name: String,
    detail: String,
}

struct ToolMeta {
    id: ToolCallId,
    name: String,
    input: String,
}

#[derive(Default)]
struct CodexState {
    /// Model and effort overrides, sent with every `turn/start`.
    model: Option<String>,
    effort: Option<String>,
    /// Custom agent the user picked; Codex selects agents by name in the prompt.
    agent: Option<String>,
    /// Subagent threads: thread id → title, and what was already reported for them.
    child_titles: HashMap<String, String>,
    /// Threads whose title came from the thread itself (nickname/role), which beats a title
    /// guessed from the spawn prompt.
    child_named: HashSet<String>,
    /// Threads whose name has already been looked up, so it happens once.
    child_looked_up: HashSet<String>,
    child_calls: HashMap<String, ToolCallId>,
    child_live: HashSet<String>,
    child_synced: HashSet<String>,
    turn: Option<TurnId>,
    /// Codex's own id for the running turn, needed for `turn/interrupt`.
    codex_turn: Option<String>,
    cancel_requested: bool,
    last_error: Option<String>,
    limit_reset: Option<i64>,
    limit_announced: bool,
    limit_error: bool,
    tools: HashMap<String, ToolMeta>,
    queue: VecDeque<QueuedPermission>,
    active: Option<QueuedPermission>,
}

struct CodexShared {
    me: OnceLock<Weak<CodexShared>>,
    emit: Emitter,
    client: OnceLock<Arc<RpcClient>>,
    thread_id: OnceLock<String>,
    exit: Mutex<Option<ExitInfo>>,
    state: Mutex<CodexState>,
}

impl CodexShared {
    fn with_exit_info(&self, message: String) -> String {
        match self.exit.lock().as_ref() {
            Some(info) => info.describe("codex"),
            None => message,
        }
    }

    fn on_incoming(&self, incoming: Incoming) {
        match incoming {
            Incoming::Notification { method, params } => self.on_notification(&method, &params),
            Incoming::Request { id, method, params } => {
                if method == COMMAND_APPROVAL || method == FILE_CHANGE_APPROVAL {
                    self.on_approval(id, &method, &params);
                } else if let Some(client) = self.client.get() {
                    let _ = client.respond_error(&id, -32601, "method not supported by Ataraxia");
                }
            }
            Incoming::Closed(info) => {
                let message = info.describe("codex");
                *self.exit.lock() = Some(info);
                (self.emit)(BackendEvent::Error { message });
            }
        }
    }

    /// Tells the host where the account's limits stand, if the snapshot has any window.
    fn report_usage(&self, snapshot: Option<&Value>) {
        let Some((plan, windows)) = snapshot.and_then(usage_from_snapshot) else {
            return;
        };
        if let Some(raw) = snapshot {
            let short = ["primary", "secondary"]
                .into_iter()
                .filter_map(|key| raw.get(key))
                .find(|node| {
                    node.get("windowDurationMins")
                        .and_then(Value::as_i64)
                        .is_some_and(|minutes| {
                            UsageWindowKind::from_minutes(minutes) == UsageWindowKind::FiveHour
                        })
                });
            if let Some(short) = short {
                self.state.lock().limit_reset = short
                    .get("usedPercent")
                    .and_then(Value::as_f64)
                    .filter(|used| *used >= 100.0)
                    .and_then(|_| short.get("resetsAt").and_then(Value::as_i64));
            }
        }
        (self.emit)(BackendEvent::Usage { plan, windows });
    }

    fn on_notification(&self, method: &str, params: &Value) {
        // The account's limits are not about any one thread or turn.
        if method == "account/rateLimits/updated" {
            self.report_usage(params.get("rateLimits"));
            return;
        }
        // A subagent's thread announces itself with its nickname and role.
        if method == "thread/started" {
            if let (Some(thread), Some(main)) = (params.get("thread"), self.thread_id.get()) {
                let id = thread.get("id").and_then(Value::as_str);
                if let (Some(id), Some(title)) = (id, thread_title(thread)) {
                    if id != main {
                        let mut state = self.state.lock();
                        self.name_child(&mut state, id, title, true);
                    }
                }
            }
            return;
        }
        // Spawned subagents run in their own threads; keep them out of the main conversation.
        if let (Some(thread), Some(main)) = (
            params.get("threadId").and_then(Value::as_str),
            self.thread_id.get(),
        ) {
            if thread != main {
                self.on_child_notification(thread, method, params);
                return;
            }
        }
        if method == "thread/tokenUsage/updated" {
            if let (Some(used), Some(size)) = (
                params
                    .pointer("/tokenUsage/last/totalTokens")
                    .and_then(Value::as_u64),
                params
                    .pointer("/tokenUsage/modelContextWindow")
                    .and_then(Value::as_u64),
            ) {
                if size > 0 {
                    (self.emit)(BackendEvent::ContextUsage { used, size });
                }
            }
            return;
        }
        let mut state = self.state.lock();
        let Some(turn_id) = state.turn else {
            return;
        };
        match method {
            "turn/started" => {
                state.codex_turn = params
                    .pointer("/turn/id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let cancel_now = state.cancel_requested && state.codex_turn.is_some();
                let shared = self.me.get().cloned();
                drop(state);
                if cancel_now {
                    if let Some(shared) = shared {
                        thread::spawn(move || {
                            if let Some(shared) = shared.upgrade() {
                                shared.interrupt();
                            }
                        });
                    }
                }
                return;
            }
            "item/reasoning/summaryTextDelta" => {
                if let Some(text) = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    (self.emit)(BackendEvent::Reasoning {
                        turn_id,
                        text: text.to_string(),
                    });
                }
            }
            "item/agentMessage/delta" => {
                let text = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !text.is_empty() {
                    (self.emit)(BackendEvent::Delta {
                        turn_id,
                        text: text.to_string(),
                    });
                }
            }
            "item/started" => {
                if let Some(item) = params.get("item") {
                    if item.get("type").and_then(Value::as_str) == Some("collabAgentToolCall") {
                        self.on_collab(&mut state, item);
                    }
                    self.announce_item(&mut state, turn_id, item);
                }
            }
            "item/completed" => {
                if let Some(item) = params.get("item") {
                    if item.get("type").and_then(Value::as_str) == Some("collabAgentToolCall") {
                        self.on_collab(&mut state, item);
                    }
                    if let Some(call_id) = self.announce_item(&mut state, turn_id, item) {
                        let (output, ok) = item_result(item);
                        (self.emit)(BackendEvent::ToolResult {
                            turn_id,
                            call_id,
                            output: truncate_output(output),
                            ok,
                        });
                    }
                }
            }
            "error" => {
                let will_retry = params
                    .get("willRetry")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let limited = params
                    .pointer("/error/codexErrorInfo")
                    .and_then(Value::as_str)
                    == Some("usageLimitExceeded");
                if limited && !will_retry {
                    state.limit_error = true;
                }
                if limited && will_retry && !state.limit_announced {
                    if let Some(resets_at) = state
                        .limit_reset
                        .filter(|at| *at > time::OffsetDateTime::now_utc().unix_timestamp())
                    {
                        state.limit_announced = true;
                        (self.emit)(BackendEvent::RateLimited { turn_id, resets_at });
                        let shared = self.me.get().cloned();
                        drop(state);
                        if let Some(shared) = shared {
                            thread::spawn(move || {
                                if let Some(shared) = shared.upgrade() {
                                    shared.interrupt();
                                }
                            });
                        }
                        return;
                    }
                }
                if !will_retry {
                    state.last_error = params
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
            }
            "turn/completed" => {
                let status = params
                    .pointer("/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let cancelled = std::mem::take(&mut state.cancel_requested);
                let last_error = state.last_error.take();
                self.settle_children(&mut state, status == "completed" && !cancelled);
                state.turn = None;
                state.codex_turn = None;
                state.queue.clear();
                state.active = None;
                if status == "failed" && !cancelled {
                    let limited = state.limit_error
                        || params
                            .pointer("/turn/error/codexErrorInfo")
                            .and_then(Value::as_str)
                            == Some("usageLimitExceeded");
                    if limited && !state.limit_announced {
                        if let Some(resets_at) = state
                            .limit_reset
                            .filter(|at| *at > time::OffsetDateTime::now_utc().unix_timestamp())
                        {
                            (self.emit)(BackendEvent::RateLimited { turn_id, resets_at });
                        }
                    }
                    let message = params
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or(last_error)
                        .unwrap_or_else(|| "Codex turn failed".to_string());
                    (self.emit)(BackendEvent::Error { message });
                } else {
                    (self.emit)(BackendEvent::TurnDone {
                        turn_id,
                        ok: status == "completed" && !cancelled,
                    });
                }
            }
            _ => {}
        }
    }

    fn child_title(state: &CodexState, thread: &str) -> String {
        state
            .child_titles
            .get(thread)
            .cloned()
            .unwrap_or_else(|| "Subagent".to_string())
    }

    /// Progress of a spawned subagent's own thread, when the server streams it.
    fn on_child_notification(&self, thread: &str, method: &str, params: &Value) {
        let mut state = self.state.lock();
        // Its events can arrive before anything told us what this thread is.
        if !state.child_titles.contains_key(thread) {
            state
                .child_titles
                .insert(thread.to_string(), "Subagent".to_string());
        }
        if !state.child_named.contains(thread) && state.child_looked_up.insert(thread.to_string()) {
            if let Some(me) = self.me.get().and_then(Weak::upgrade) {
                let thread = thread.to_string();
                thread::spawn(move || me.look_up_child_name(&thread));
            }
        }
        let title = Self::child_title(&state, thread);
        let id = thread.to_string();
        match method {
            "item/reasoning/summaryTextDelta" => {
                if let Some(text) = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    state.child_live.insert(id.clone());
                    (self.emit)(BackendEvent::Subagent {
                        id,
                        title,
                        update: SubagentUpdate::Reasoning {
                            text: text.to_string(),
                        },
                    });
                }
            }
            "item/agentMessage/delta" => {
                let text = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !text.is_empty() {
                    state.child_live.insert(id.clone());
                    (self.emit)(BackendEvent::Subagent {
                        id,
                        title,
                        update: SubagentUpdate::Delta {
                            text: text.to_string(),
                        },
                    });
                }
            }
            "item/started" | "item/completed" => {
                let Some(item) = params.get("item") else {
                    return;
                };
                let (Some(item_id), Some((name, input))) =
                    (item.get("id").and_then(Value::as_str), item_summary(item))
                else {
                    return;
                };
                state.child_live.insert(id.clone());
                let call_id = match state.child_calls.get(item_id) {
                    Some(call_id) => *call_id,
                    None => {
                        let call_id = ToolCallId::new();
                        state.child_calls.insert(item_id.to_string(), call_id);
                        (self.emit)(BackendEvent::Subagent {
                            id: id.clone(),
                            title: title.clone(),
                            update: SubagentUpdate::Tool {
                                call_id,
                                name,
                                input,
                            },
                        });
                        call_id
                    }
                };
                if method == "item/completed" {
                    let (output, ok) = item_result(item);
                    (self.emit)(BackendEvent::Subagent {
                        id,
                        title,
                        update: SubagentUpdate::ToolResult {
                            call_id,
                            output: truncate_output(output),
                            ok,
                        },
                    });
                }
            }
            "turn/started" => {
                // A new turn on an existing subagent (for example after the user wrote to it).
                state.child_synced.remove(&id);
                state.child_live.insert(id.clone());
                (self.emit)(BackendEvent::Subagent {
                    id,
                    title,
                    update: SubagentUpdate::Started,
                });
            }
            "turn/completed" => {
                let ok = params
                    .pointer("/turn/status")
                    .and_then(Value::as_str)
                    .is_none_or(|status| status == "completed");
                state.child_synced.insert(id.clone());
                (self.emit)(BackendEvent::Subagent {
                    id,
                    title,
                    update: SubagentUpdate::Done { ok },
                });
            }
            _ => {}
        }
    }

    /// A `collabAgentToolCall` item names the threads a spawn created and how they are doing.
    fn on_collab(&self, state: &mut CodexState, item: &Value) {
        let prompt = item
            .get("prompt")
            .and_then(Value::as_str)
            .map(first_line_title);
        let spawns = item.get("tool").and_then(Value::as_str) == Some("spawnAgent");
        if spawns {
            if let Some(threads) = item.get("receiverThreadIds").and_then(Value::as_array) {
                for thread in threads.iter().filter_map(Value::as_str) {
                    let title = prompt.clone().unwrap_or_else(|| "Subagent".to_string());
                    self.name_child(state, thread, title, false);
                }
            }
        }
        if let Some(states) = item.get("agentsStates").and_then(Value::as_object) {
            for (thread, agent) in states {
                let finished = matches!(
                    agent.get("status").and_then(Value::as_str),
                    Some("completed" | "errored" | "shutdown")
                );
                if finished {
                    self.sync_child(state, thread);
                }
            }
        }
    }

    /// Sets a subagent's title and tells the UI. A title taken from the thread itself wins over
    /// one guessed from the spawn prompt, and nothing is announced when it did not change.
    fn name_child(&self, state: &mut CodexState, thread: &str, title: String, from_thread: bool) {
        if from_thread {
            state.child_named.insert(thread.to_string());
        } else if state.child_named.contains(thread) {
            return;
        }
        let current = state.child_titles.get(thread);
        let placeholder = current.is_none_or(|current| current == "Subagent");
        if current == Some(&title) || (!from_thread && !placeholder) {
            return;
        }
        state.child_titles.insert(thread.to_string(), title.clone());
        (self.emit)(BackendEvent::Subagent {
            id: thread.to_string(),
            title,
            update: SubagentUpdate::Started,
        });
    }

    /// Asks the server what a subagent thread is called (its nickname and role).
    fn look_up_child_name(&self, thread: &str) {
        let Some(client) = self.client.get() else {
            return;
        };
        let Ok(result) = client.request(
            "thread/read",
            json!({ "threadId": thread }),
            Some(INTERRUPT_TIMEOUT),
        ) else {
            return;
        };
        if let Some(title) = result.get("thread").and_then(thread_title) {
            let mut state = self.state.lock();
            self.name_child(&mut state, thread, title, true);
        }
    }

    /// Reads a finished subagent thread back (once), unless its events already streamed in.
    fn sync_child(&self, state: &mut CodexState, thread: &str) {
        if state.child_live.contains(thread) || !state.child_synced.insert(thread.to_string()) {
            return;
        }
        let title = Self::child_title(state, thread);
        if let Some(me) = self.me.get().and_then(Weak::upgrade) {
            let thread = thread.to_string();
            // The reader thread must not wait for a reply, so the read runs on its own thread.
            thread::spawn(move || me.replay_child(&thread, &title));
        }
    }

    fn replay_child(&self, thread: &str, title: &str) {
        let Some(client) = self.client.get() else {
            return;
        };
        let read = client.request(
            "thread/read",
            json!({ "threadId": thread, "includeTurns": true }),
            Some(INTERRUPT_TIMEOUT),
        );
        let (title, ok) = match &read {
            Ok(result) => {
                let named = ["agentNickname", "agentRole", "name"]
                    .iter()
                    .find_map(|key| {
                        result
                            .pointer(&format!("/thread/{key}"))
                            .and_then(Value::as_str)
                            .filter(|value| !value.trim().is_empty())
                    });
                let title = match (named, title) {
                    (Some(name), "Subagent") => name.to_string(),
                    _ => title.to_string(),
                };
                (title, true)
            }
            Err(_) => (title.to_string(), false),
        };
        let emit = |update| {
            (self.emit)(BackendEvent::Subagent {
                id: thread.to_string(),
                title: title.clone(),
                update,
            });
        };
        if let Ok(result) = &read {
            let turns = result
                .pointer("/thread/turns")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for item in turns
                .iter()
                .filter_map(|turn| turn.get("items").and_then(Value::as_array))
                .flatten()
            {
                match item.get("type").and_then(Value::as_str) {
                    Some("agentMessage") => {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                emit(SubagentUpdate::Delta {
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    _ => {
                        if let Some((name, input)) = item_summary(item) {
                            let call_id = ToolCallId::new();
                            emit(SubagentUpdate::Tool {
                                call_id,
                                name,
                                input,
                            });
                            let (output, ok) = item_result(item);
                            emit(SubagentUpdate::ToolResult {
                                call_id,
                                output: truncate_output(output),
                                ok,
                            });
                        }
                    }
                }
            }
        }
        emit(SubagentUpdate::Done { ok });
    }

    /// When the main turn ends, subagents that never streamed are read back and all are closed.
    fn settle_children(&self, state: &mut CodexState, ok: bool) {
        let threads: Vec<String> = state.child_titles.keys().cloned().collect();
        for thread in threads {
            if state.child_live.contains(&thread) {
                if state.child_synced.insert(thread.clone()) {
                    let title = Self::child_title(state, &thread);
                    (self.emit)(BackendEvent::Subagent {
                        id: thread,
                        title,
                        update: SubagentUpdate::Done { ok },
                    });
                }
            } else {
                self.sync_child(state, &thread);
            }
        }
    }

    /// Starts a turn on a subagent's own thread. A thread that was unloaded is resumed first.
    fn run_child_turn(&self, thread: &str, text: &str) {
        let Some(client) = self.client.get() else {
            return;
        };
        let start = || {
            client.request(
                "turn/start",
                json!({
                    "threadId": thread,
                    "input": [{ "type": "text", "text": text, "text_elements": [] }]
                }),
                Some(HANDSHAKE_TIMEOUT),
            )
        };
        let outcome = match start() {
            Ok(result) => Ok(result),
            Err(_) => client
                .request(
                    "thread/resume",
                    json!({ "threadId": thread }),
                    Some(HANDSHAKE_TIMEOUT),
                )
                .and_then(|_| start()),
        };
        if let Err(error) = outcome {
            let title = Self::child_title(&self.state.lock(), thread);
            (self.emit)(BackendEvent::Subagent {
                id: thread.to_string(),
                title,
                update: SubagentUpdate::Delta {
                    text: format!("\n\n(could not reach this subagent: {})", error.message),
                },
            });
            (self.emit)(BackendEvent::Subagent {
                id: thread.to_string(),
                title: Self::child_title(&self.state.lock(), thread),
                update: SubagentUpdate::Done { ok: false },
            });
        }
    }

    /// Models the server offers, with the effort levels each one supports.
    fn list_models(&self) -> Option<(Vec<ModelChoice>, Option<String>)> {
        let client = self.client.get()?;
        let result = client
            .request(
                "model/list",
                json!({ "includeHidden": false, "limit": 100 }),
                Some(INTERRUPT_TIMEOUT),
            )
            .ok()?;
        Some(parse_model_list(&result))
    }

    /// Announces tool-like items once and returns their call id (None for plain messages).
    fn announce_item(
        &self,
        state: &mut CodexState,
        turn_id: TurnId,
        item: &Value,
    ) -> Option<ToolCallId> {
        let item_id = item.get("id").and_then(Value::as_str)?;
        let (name, input) = item_summary(item)?;
        Some(self.announce_tool(state, turn_id, item_id, &name, input))
    }

    fn announce_tool(
        &self,
        state: &mut CodexState,
        turn_id: TurnId,
        item_id: &str,
        name: &str,
        input: String,
    ) -> ToolCallId {
        if let Some(meta) = state.tools.get_mut(item_id) {
            if !input.is_empty() && input != meta.input {
                meta.input = input.clone();
                (self.emit)(BackendEvent::ToolUpdate {
                    turn_id,
                    call_id: meta.id,
                    name: None,
                    input: Some(input),
                });
            }
            return meta.id;
        }
        let id = ToolCallId::new();
        state.tools.insert(
            item_id.to_string(),
            ToolMeta {
                id,
                name: name.to_string(),
                input: input.clone(),
            },
        );
        (self.emit)(BackendEvent::Tool {
            turn_id,
            call_id: id,
            name: name.to_string(),
            input,
        });
        id
    }

    fn on_approval(&self, rpc_id: Value, method: &str, params: &Value) {
        let mut state = self.state.lock();
        let Some(turn_id) = state.turn else {
            drop(state);
            self.answer(&rpc_id, "cancel");
            return;
        };
        let item_id = params
            .get("itemId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let reason = params.get("reason").and_then(Value::as_str);
        let (tool_name, subject, announce_input) = if method == COMMAND_APPROVAL {
            let command = params.get("command").and_then(Value::as_str).unwrap_or("");
            (
                "command",
                format!("Allow running: {command}"),
                command.to_string(),
            )
        } else {
            (
                "file_change",
                "Allow changing files".to_string(),
                String::new(),
            )
        };
        if !item_id.is_empty() {
            self.announce_tool(&mut state, turn_id, &item_id, tool_name, announce_input);
        }
        let detail = match reason {
            Some(reason) if !reason.is_empty() => format!("{subject} ({reason})"),
            _ => subject,
        };
        state.queue.push_back(QueuedPermission {
            request_id: PermissionRequestId::new(),
            turn_id,
            rpc_id,
            tool_name: tool_name.to_string(),
            detail,
        });
        self.pump_permissions(&mut state);
    }

    fn pump_permissions(&self, state: &mut CodexState) {
        if state.active.is_some() {
            return;
        }
        if let Some(next) = state.queue.pop_front() {
            (self.emit)(BackendEvent::Permission {
                turn_id: next.turn_id,
                request_id: next.request_id,
                tool_name: next.tool_name.clone(),
                detail: next.detail.clone(),
                allow_always: None,
                questions: Vec::new(),
            });
            state.active = Some(next);
        }
    }

    fn answer(&self, rpc_id: &Value, decision: &str) {
        if let Some(client) = self.client.get() {
            let _ = client.respond(rpc_id, json!({ "decision": decision }));
        }
    }

    fn interrupt(&self) {
        let (Some(client), Some(thread_id)) = (self.client.get(), self.thread_id.get()) else {
            return;
        };
        let Some(codex_turn) = self.state.lock().codex_turn.clone() else {
            // `turn/start` has not answered yet; its thread interrupts once it does.
            return;
        };
        let _ = client.request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": codex_turn }),
            Some(INTERRUPT_TIMEOUT),
        );
    }

    fn run_turn_start(
        &self,
        turn_id: TurnId,
        text: String,
        images: Vec<ImageFile>,
        extra: Vec<Value>,
    ) {
        let (Some(client), Some(thread_id)) = (self.client.get(), self.thread_id.get()) else {
            return;
        };
        let (model, effort, agent) = {
            let state = self.state.lock();
            (
                state.model.clone(),
                state.effort.clone(),
                state.agent.clone(),
            )
        };
        let text = prompt_text(agent.as_deref(), &text);
        // The pictures are files on disk the app owns; Codex takes them by path.
        let mut input: Vec<Value> = images
            .iter()
            .map(|image| json!({ "type": "localImage", "path": image.path }))
            .collect();
        if !text.trim().is_empty() || input.is_empty() {
            input.push(json!({ "type": "text", "text": text, "text_elements": [] }));
        }
        input.extend(extra);
        let mut params = json!({
            "threadId": thread_id,
            "input": input
        });
        if let Some(model) = model {
            params["model"] = json!(model);
        }
        if let Some(effort) = effort {
            params["effort"] = json!(effort);
        }
        let outcome = client.request("turn/start", params, Some(HANDSHAKE_TIMEOUT));
        match outcome {
            Ok(result) => {
                let cancel_now = {
                    let mut state = self.state.lock();
                    if state.turn != Some(turn_id) {
                        return;
                    }
                    state.codex_turn = result
                        .pointer("/turn/id")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    state.cancel_requested
                };
                if cancel_now {
                    self.interrupt();
                }
            }
            Err(error) => {
                {
                    let mut state = self.state.lock();
                    if state.turn != Some(turn_id) {
                        return;
                    }
                    state.turn = None;
                }
                (self.emit)(BackendEvent::Error {
                    message: self.with_exit_info(error.message),
                });
            }
        }
    }
}

struct CodexSession {
    shared: Arc<CodexShared>,
    cwd: PathBuf,
    /// `model/list` answer, fetched on first use.
    models: OnceLock<(Vec<ModelChoice>, Option<String>)>,
    /// The thread of an earlier run was picked up again.
    resumed: bool,
}

impl CodexSession {
    fn start_turn(&self, turn_id: TurnId, text: &str, images: Vec<ImageFile>) -> Result<()> {
        if !self.is_alive() {
            return Err(Error::new(
                ErrorCode::Agent,
                self.shared.with_exit_info("codex is not running".into()),
            ));
        }
        {
            let mut state = self.shared.state.lock();
            state.turn = Some(turn_id);
            state.codex_turn = None;
            state.cancel_requested = false;
            state.last_error = None;
            state.limit_announced = false;
            state.limit_error = false;
        }
        if let Some(("compact", _)) = split_command(text) {
            let Some(thread_id) = self.shared.thread_id.get() else {
                return Err(Error::new(
                    ErrorCode::Agent,
                    "Codex thread is not available",
                ));
            };
            let result = self
                .shared
                .client
                .get()
                .ok_or_else(|| Error::new(ErrorCode::Agent, "Codex is not running"))?
                .request(
                    "thread/compact/start",
                    json!({ "threadId": thread_id }),
                    Some(COMMANDS_TIMEOUT),
                );
            if let Err(error) = result {
                self.shared.state.lock().turn = None;
                return Err(error);
            }
            return Ok(());
        }
        let shared = Arc::clone(&self.shared);
        let text = text.to_string();
        thread::spawn(move || shared.run_turn_start(turn_id, text, images, Vec::new()));
        Ok(())
    }
}

impl BackendSession for CodexSession {
    fn conversation(&self) -> Option<String> {
        self.shared.thread_id.get().cloned()
    }

    fn resumed(&self) -> bool {
        self.resumed
    }

    fn apply_settings(
        &self,
        model: Option<&str>,
        effort: Option<&str>,
        agent: Option<&str>,
    ) -> bool {
        // `turn/start` overrides apply to this turn and the following ones, no restart needed.
        let mut state = self.shared.state.lock();
        state.model = model.map(str::to_string);
        state.effort = effort.map(str::to_string);
        state.agent = agent.map(str::to_string);
        true
    }

    fn message_subagent(
        &self,
        _turn_id: TurnId,
        subagent_id: &str,
        text: &str,
    ) -> Result<SubagentRoute> {
        if !self.is_alive() {
            return Err(Error::new(
                ErrorCode::Agent,
                self.shared.with_exit_info("codex is not running".into()),
            ));
        }
        let shared = Arc::clone(&self.shared);
        let (thread_id, text) = (subagent_id.to_string(), text.to_string());
        // The reply may take a while; the child's events stream in as notifications meanwhile.
        thread::spawn(move || shared.run_child_turn(&thread_id, &text));
        Ok(SubagentRoute::Direct)
    }

    fn options(&self) -> SessionOptions {
        let listed = match self.models.get() {
            Some(listed) => Some(listed),
            None => self
                .shared
                .list_models()
                .map(|listed| self.models.get_or_init(|| listed)),
        };
        let (models, default_model) = listed.cloned().unwrap_or_default();
        let current = self
            .shared
            .state
            .lock()
            .model
            .clone()
            .or(default_model.clone());
        let efforts = models
            .iter()
            .find(|model| Some(&model.id) == current.as_ref())
            .map(|model| model.efforts.clone())
            .unwrap_or_default();
        SessionOptions {
            models,
            default_model,
            efforts,
            agents: codex_agents(&self.cwd),
        }
    }

    fn prompt(&self, turn_id: TurnId, text: &str) -> Result<()> {
        self.start_turn(turn_id, text, Vec::new())
    }

    fn prompt_with_images(&self, turn_id: TurnId, text: &str, images: &[ImageFile]) -> Result<()> {
        self.start_turn(turn_id, text, images.to_vec())
    }

    fn cancel(&self) -> Result<()> {
        let pending: Vec<Value> = {
            let mut state = self.shared.state.lock();
            if state.turn.is_none() {
                return Ok(());
            }
            state.cancel_requested = true;
            let mut ids: Vec<Value> = state.queue.drain(..).map(|item| item.rpc_id).collect();
            ids.extend(state.active.take().map(|item| item.rpc_id));
            ids
        };
        for rpc_id in pending {
            self.shared.answer(&rpc_id, "cancel");
        }
        let shared = Arc::clone(&self.shared);
        thread::spawn(move || shared.interrupt());
        Ok(())
    }

    fn resolve_permission(&self, decision: &PermissionDecision) -> Result<()> {
        let rpc_id = {
            let mut state = self.shared.state.lock();
            let matches_active = state
                .active
                .as_ref()
                .is_some_and(|active| active.request_id == decision.request_id);
            if !matches_active {
                return Err(Error::new(ErrorCode::Invalid, "no matching permission"));
            }
            state.active.take().expect("checked above").rpc_id
        };
        self.shared
            .answer(&rpc_id, if decision.allow { "accept" } else { "decline" });
        let mut state = self.shared.state.lock();
        self.shared.pump_permissions(&mut state);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.shared
            .client
            .get()
            .is_some_and(|client| client.is_alive())
    }

    fn process_id(&self) -> Option<u32> {
        self.shared.client.get().map(|client| client.pid())
    }

    fn shutdown(&self) {
        if let Some(client) = self.shared.client.get() {
            client.kill();
        }
    }
}

/// Codex picks a custom agent by name in the prompt.
fn prompt_text(agent: Option<&str>, text: &str) -> String {
    match agent {
        Some(agent) => format!("Use the `{agent}` custom agent for this request.\n\n{text}"),
        None => text.to_string(),
    }
}

/// A readable name for a subagent thread: its nickname (with role), else its name or preview.
fn thread_title(thread: &Value) -> Option<String> {
    let text = |key: &str| {
        thread
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    match (text("agentNickname"), text("agentRole")) {
        (Some(nick), Some(role)) if !role.eq_ignore_ascii_case(nick) => {
            Some(format!("{nick} ({role})"))
        }
        (Some(nick), _) => Some(nick.to_string()),
        (None, Some(role)) => Some(role.to_string()),
        (None, None) => text("name")
            .map(str::to_string)
            .or_else(|| text("preview").map(first_line_title)),
    }
}

fn first_line_title(prompt: &str) -> String {
    let line = prompt
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let line = line.trim();
    if line.chars().count() > 60 {
        format!("{}…", line.chars().take(60).collect::<String>().trim_end())
    } else if line.is_empty() {
        "Subagent".to_string()
    } else {
        line.to_string()
    }
}

fn parse_model_list(result: &Value) -> (Vec<ModelChoice>, Option<String>) {
    let mut default_model = None;
    let models = result
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.get("hidden").and_then(Value::as_bool) != Some(true))
                .filter_map(|item| {
                    let id = item
                        .get("model")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)?
                        .to_string();
                    if item.get("isDefault").and_then(Value::as_bool) == Some(true) {
                        default_model = Some(id.clone());
                    }
                    let label = item
                        .get("displayName")
                        .and_then(Value::as_str)
                        .unwrap_or(&id)
                        .to_string();
                    let efforts = item
                        .get("supportedReasoningEfforts")
                        .and_then(Value::as_array)
                        .map(|levels| {
                            levels
                                .iter()
                                .filter_map(|level| {
                                    level
                                        .get("reasoningEffort")
                                        .and_then(Value::as_str)
                                        .map(str::to_string)
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(ModelChoice { id, label, efforts })
                })
                .collect()
        })
        .unwrap_or_default();
    (models, default_model)
}

/// Name + input text for the item kinds that act like tool calls.
fn item_summary(item: &Value) -> Option<(String, String)> {
    let text = |key: &str| item.get(key).and_then(Value::as_str);
    match item.get("type").and_then(Value::as_str)? {
        "commandExecution" => Some(("command".into(), text("command").unwrap_or("").to_string())),
        "fileChange" => {
            let paths = file_change_paths(item);
            Some(("file_change".into(), paths.join("\n")))
        }
        "mcpToolCall" => {
            let name = format!(
                "{}/{}",
                text("server").unwrap_or("mcp"),
                text("tool").unwrap_or("tool")
            );
            let input = item
                .get("arguments")
                .filter(|args| !args.is_null())
                .and_then(|args| serde_json::to_string_pretty(args).ok())
                .unwrap_or_default();
            Some((name, input))
        }
        "webSearch" => Some(("web_search".into(), text("query").unwrap_or("").to_string())),
        _ => None,
    }
}

fn file_change_paths(item: &Value) -> Vec<String> {
    item.get("changes")
        .and_then(Value::as_array)
        .map(|changes| {
            changes
                .iter()
                .filter_map(|change| {
                    let path = change.get("path").and_then(Value::as_str)?;
                    let kind = change
                        .pointer("/kind/type")
                        .or_else(|| change.get("kind"))
                        .and_then(Value::as_str)
                        .unwrap_or("update");
                    Some(format!("{kind} {path}"))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Output text and success flag for a completed tool-like item.
fn item_result(item: &Value) -> (String, bool) {
    let status = item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let completed = status == "completed";
    match item.get("type").and_then(Value::as_str) {
        Some("commandExecution") => {
            let output = item
                .get("aggregatedOutput")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let exit = item.get("exitCode").and_then(Value::as_i64);
            let ok = completed && exit.unwrap_or(0) == 0;
            let output = match (status, exit) {
                ("declined", _) => "declined by user".to_string(),
                (_, Some(code)) if code != 0 => format!("{output}\n(exit code {code})")
                    .trim_start()
                    .to_string(),
                _ => output.to_string(),
            };
            (output, ok)
        }
        Some("fileChange") => {
            let output = if status == "declined" {
                "declined by user".to_string()
            } else {
                file_change_paths(item).join("\n")
            };
            (output, completed)
        }
        Some("mcpToolCall") => {
            let output = item
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    item.pointer("/result/content")
                        .and_then(Value::as_array)
                        .map(|blocks| {
                            blocks
                                .iter()
                                .filter_map(|block| block.get("text").and_then(Value::as_str))
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                })
                .unwrap_or_default();
            (output, completed)
        }
        _ => (String::new(), completed),
    }
}

/// The windows of a rate-limit snapshot. A window says how long it lasts; that tells the
/// five-hour limit from the weekly one (a plan may only have one of them). Without a length the
/// first is the short one and the second the long one.
fn usage_from_snapshot(snapshot: &Value) -> Option<(Option<String>, Vec<UsageWindow>)> {
    let mut windows = Vec::new();
    for (name, fallback) in [
        ("primary", UsageWindowKind::FiveHour),
        ("secondary", UsageWindowKind::Weekly),
    ] {
        let Some(node) = snapshot.get(name).filter(|node| node.is_object()) else {
            continue;
        };
        let Some(used) = node.get("usedPercent").and_then(Value::as_f64) else {
            continue;
        };
        let kind = node
            .get("windowDurationMins")
            .and_then(Value::as_i64)
            .map_or(fallback, UsageWindowKind::from_minutes);
        let resets_at = node.get("resetsAt").and_then(Value::as_i64);
        windows.push(UsageWindow::new(kind, used, resets_at));
    }
    if windows.is_empty() {
        return None;
    }
    let plan = snapshot
        .get("planType")
        .and_then(Value::as_str)
        .filter(|plan| *plan != "unknown")
        .map(str::to_string);
    Some((plan, windows))
}

#[cfg(test)]
mod tests {
    #[test]
    fn interrupts_the_codex_retry_after_a_confirmed_limit() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "limit_retry")
            .expect("prompt");
        let seen = h.until("limit", |event| {
            matches!(event, BackendEvent::RateLimited { .. })
        });
        assert!(
            seen.iter()
                .any(|event| matches!(event, BackendEvent::RateLimited { .. }))
        );
        let end = h.until("interrupted", |event| {
            matches!(event, BackendEvent::TurnDone { .. })
        });
        assert!(
            end.iter()
                .any(|event| matches!(event, BackendEvent::TurnDone { ok: false, .. }))
        );
        h.session.shutdown();
    }

    #[test]
    fn missing_limit_reset_does_not_schedule_a_resume() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "limit_no_reset")
            .expect("prompt");
        let seen = h.until("failed", |event| {
            matches!(
                event,
                BackendEvent::Error { .. } | BackendEvent::TurnDone { .. }
            )
        });
        assert!(
            !seen
                .iter()
                .any(|event| matches!(event, BackendEvent::RateLimited { .. }))
        );
        h.session.shutdown();
    }

    #[test]
    fn rate_limit_is_reported_before_the_turn_ends() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "limit please")
            .expect("prompt");
        let seen = h.until("limit", |event| {
            matches!(event, BackendEvent::RateLimited { .. })
        });
        assert!(seen.iter().any(|event| matches!(event, BackendEvent::RateLimited { resets_at, .. } if *resets_at > time::OffsetDateTime::now_utc().unix_timestamp())));
        let end = h.until("turn end", |event| {
            matches!(
                event,
                BackendEvent::Error { .. } | BackendEvent::TurnDone { .. }
            )
        });
        assert!(
            !end.iter()
                .any(|event| matches!(event, BackendEvent::TurnDone { ok: true, .. }))
        );
        h.session.shutdown();
    }

    #[test]
    fn streams_reasoning_separately_from_the_answer() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "reasoning please")
            .expect("prompt");
        let seen = h.until("turn done", |event| {
            matches!(event, BackendEvent::TurnDone { .. })
        });
        h.session.shutdown();
        let reasoning: String = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Reasoning { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        let answer: String = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::ContextUsage {
                used: 42000,
                size: 200000
            }
        )));
        assert_eq!(reasoning, "Consider this");
        assert_eq!(answer, "Answer");
    }

    #[test]
    fn portable_http_headers_become_codex_http_headers() {
        let servers = serde_json::from_value(json!({
            "remote": {
                "url": "https://example.test/mcp",
                "headers": { "Authorization": "Bearer token" }
            },
            "local": { "command": "mcp-server", "args": ["--stdio"] }
        }))
        .expect("portable MCP servers");
        let converted = codex_mcp_servers(&servers);
        assert_eq!(
            converted["remote"]["http_headers"]["Authorization"],
            "Bearer token"
        );
        assert!(converted["remote"].get("headers").is_none());
        assert_eq!(converted["local"]["command"], "mcp-server");
    }

    #[test]
    fn codex_skills_are_enabled_only_when_their_paths_are_selected() {
        let root = std::env::temp_dir().join(format!(
            "ataraxia-codex-skill-selection-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        ));
        let selected_path = root.join("selected/SKILL.md");
        std::fs::create_dir_all(selected_path.parent().expect("skill directory"))
            .expect("create skill directory");
        std::fs::write(&selected_path, "selected").expect("write selected skill");
        let selected_path_text = selected_path.to_string_lossy().into_owned();
        let selected_paths = HashSet::from([canonical_skill_path(&selected_path)]);
        let system_path = "/system/imagegen/SKILL.md";
        let user_path = "/user/unselected/SKILL.md";
        let catalog = json!({
            "data": [{
                "cwd": root.to_string_lossy().into_owned(),
                "skills": [
                    { "name": "imagegen", "path": system_path, "enabled": true, "scope": "system" },
                    { "name": "selected", "path": selected_path_text.clone(), "enabled": false, "scope": "user" },
                    { "name": "unselected", "path": user_path, "enabled": true, "scope": "user" }
                ]
            }]
        });

        let updates = codex_skill_updates(&catalog, &root, &selected_paths)
            .expect("calculate skill allowlist");

        assert_eq!(
            updates,
            vec![
                (system_path.to_string(), false),
                (selected_path_text, true),
                (user_path.to_string(), false),
            ]
        );
        assert_eq!(
            codex_skill_updates(&catalog, &root, &HashSet::new())
                .expect("calculate empty skill allowlist"),
            vec![
                (system_path.to_string(), false),
                (user_path.to_string(), false),
            ]
        );
        std::fs::remove_dir_all(root).expect("remove temporary skill root");
    }

    #[test]
    fn the_two_windows_of_a_snapshot_are_told_apart_by_their_length() {
        let snapshot = json!({
            "planType": "pro",
            "primary": { "usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1000 },
            "secondary": { "usedPercent": 64, "windowDurationMins": 10080, "resetsAt": 2000 }
        });
        let (plan, windows) = usage_from_snapshot(&snapshot).expect("windows");
        assert_eq!(plan.as_deref(), Some("pro"));
        assert_eq!(
            windows,
            vec![
                UsageWindow::new(UsageWindowKind::FiveHour, 12.0, Some(1000)),
                UsageWindow::new(UsageWindowKind::Weekly, 64.0, Some(2000)),
            ]
        );
    }

    #[test]
    fn a_plan_with_only_a_weekly_window_does_not_show_a_five_hour_one() {
        let snapshot = json!({
            "primary": { "usedPercent": 30, "windowDurationMins": 10080 },
            "secondary": null
        });
        let (_, windows) = usage_from_snapshot(&snapshot).expect("windows");
        assert_eq!(
            windows,
            vec![UsageWindow::new(UsageWindowKind::Weekly, 30.0, None)]
        );
    }

    #[test]
    fn windows_without_a_length_are_the_short_one_then_the_long_one() {
        let snapshot = json!({
            "primary": { "usedPercent": 1 },
            "secondary": { "usedPercent": 2 }
        });
        let (_, windows) = usage_from_snapshot(&snapshot).expect("windows");
        assert_eq!(windows[0].kind, UsageWindowKind::FiveHour);
        assert_eq!(windows[1].kind, UsageWindowKind::Weekly);
    }

    #[test]
    fn a_snapshot_with_no_window_reports_nothing() {
        assert!(usage_from_snapshot(&json!({ "primary": null, "secondary": null })).is_none());
        assert!(usage_from_snapshot(&json!(null)).is_none());
    }

    #[test]
    fn a_rate_limit_update_is_reported_without_a_running_turn() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let shared = CodexShared {
            me: OnceLock::new(),
            emit: Arc::new(move |event| sink.lock().push(event)),
            client: OnceLock::new(),
            thread_id: OnceLock::new(),
            exit: Mutex::new(None),
            state: Mutex::new(CodexState::default()),
        };
        shared.on_notification(
            "account/rateLimits/updated",
            &json!({ "rateLimits": { "primary": { "usedPercent": 7, "windowDurationMins": 300 } } }),
        );
        let seen = events.lock();
        assert!(matches!(
            seen.as_slice(),
            [BackendEvent::Usage { windows, .. }] if windows[0].used_percent == 7
        ));
    }

    fn subagent_updates(events: &[BackendEvent]) -> Vec<(&str, &SubagentUpdate)> {
        events
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Subagent { title, update, .. } => Some((title.as_str(), update)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn streamed_subagent_thread_stays_out_of_the_main_conversation() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "spawn please")
            .expect("prompt");
        let seen = h.until("turn done", |event| {
            matches!(event, BackendEvent::TurnDone { .. })
        });
        h.session.shutdown();

        let updates = subagent_updates(&seen);
        assert!(updates.iter().any(|(title, update)| {
            *title == "Review the diff" && matches!(update, SubagentUpdate::Started)
        }));
        // The thread names itself afterwards, and that beats the prompt-derived guess.
        // (Its role repeats the nickname here, so only the nickname is shown.)
        assert_eq!(
            updates.iter().rev().map(|(title, _)| *title).next(),
            Some("Reviewer")
        );
        assert!(updates.iter().all(|(title, _)| *title != "Subagent"));
        let streamed: String = updates
            .iter()
            .filter_map(|(_, update)| match update {
                SubagentUpdate::Delta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(streamed, "Looks fine.");
        assert!(updates.iter().any(|(_, update)| matches!(
            update,
            SubagentUpdate::ToolResult { ok: true, output, .. } if output == "diff --git"
        )));
        assert!(
            updates
                .iter()
                .any(|(_, update)| matches!(update, SubagentUpdate::Done { ok: true }))
        );
        // The child's own turn/completed must not end the main turn early.
        let main_done = seen
            .iter()
            .filter(|event| matches!(event, BackendEvent::TurnDone { .. }))
            .count();
        assert_eq!(main_done, 1);
        let main_text: String = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(main_text, "Reviewed.");
    }

    #[test]
    fn a_subagent_seen_only_through_its_events_is_named_by_looking_its_thread_up() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "spawnfirst please")
            .expect("prompt");
        let mut seen = h.until("turn done", |event| {
            matches!(event, BackendEvent::TurnDone { .. })
        });
        // The lookup answers after the mock finishes its turn; the title follows.
        seen.extend(h.until(
            "named",
            |event| matches!(event, BackendEvent::Subagent { title, .. } if title == "Reviewer"),
        ));
        h.session.shutdown();
        let updates = subagent_updates(&seen);
        assert!(
            updates.iter().any(|(title, _)| *title == "Reviewer"),
            "{updates:?}"
        );
        // It was settled with the turn although nothing ever announced it by spawn.
        assert!(
            updates
                .iter()
                .any(|(_, update)| matches!(update, SubagentUpdate::Delta { .. }))
        );
        assert!(
            updates
                .iter()
                .any(|(_, update)| matches!(update, SubagentUpdate::Done { .. }))
        );
    }

    #[test]
    fn thread_titles_prefer_nickname_and_role_then_name_then_preview() {
        let title = |value: Value| thread_title(&value);
        assert_eq!(
            title(json!({"agentNickname": "Ada", "agentRole": "explorer"})),
            Some("Ada (explorer)".into())
        );
        assert_eq!(
            title(json!({"agentNickname": "Reviewer", "agentRole": "reviewer"})),
            Some("Reviewer".into()),
            "a role that repeats the nickname is not shown twice"
        );
        assert_eq!(title(json!({"agentNickname": "Ada"})), Some("Ada".into()));
        assert_eq!(title(json!({"agentRole": "worker"})), Some("worker".into()));
        assert_eq!(
            title(json!({"name": " Fix tests "})),
            Some("Fix tests".into())
        );
        assert_eq!(
            title(json!({"preview": "Map the repo\nthen report"})),
            Some("Map the repo".into())
        );
        assert_eq!(title(json!({"agentNickname": "", "preview": ""})), None);
    }

    #[test]
    fn silent_subagent_is_read_back_with_thread_read() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "spawnquiet please")
            .expect("prompt");
        let mut seen = h.until("turn done", |event| {
            matches!(event, BackendEvent::TurnDone { .. })
        });
        seen.extend(h.until("subagent read back", |event| {
            matches!(
                event,
                BackendEvent::Subagent {
                    update: SubagentUpdate::Done { .. },
                    ..
                }
            )
        }));
        h.session.shutdown();

        let updates = subagent_updates(&seen);
        // thread/read supplies a nickname, but the prompt title wins once it exists.
        assert!(updates.iter().all(|(title, _)| *title == "Review the diff"));
        assert!(updates.iter().any(
            |(_, update)| matches!(update, SubagentUpdate::Delta { text } if text == "All good.")
        ));
        assert!(updates.iter().any(|(_, update)| matches!(
            update,
            SubagentUpdate::Tool { name, .. } if name == "command"
        )));
        assert!(
            updates
                .iter()
                .any(|(_, update)| matches!(update, SubagentUpdate::Done { ok: true }))
        );
    }

    #[test]
    fn a_message_to_a_subagent_streams_its_reply_without_a_main_turn() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "spawn please")
            .expect("prompt");
        h.until("main turn done", |event| {
            matches!(event, BackendEvent::TurnDone { .. })
        });
        let route = h
            .session
            .message_subagent(TurnId::new(), "thr_child", "check the tests")
            .expect("message");
        assert_eq!(route, SubagentRoute::Direct);
        let seen = h.until("child reply done", |event| {
            matches!(
                event,
                BackendEvent::Subagent {
                    update: SubagentUpdate::Done { .. },
                    ..
                }
            )
        });
        h.session.shutdown();
        let updates = subagent_updates(&seen);
        assert!(
            updates
                .iter()
                .any(|(_, update)| matches!(update, SubagentUpdate::Started))
        );
        let reply: String = updates
            .iter()
            .filter_map(|(_, update)| match update {
                SubagentUpdate::Delta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(reply, "Reply to: check the tests");
        assert!(
            !seen
                .iter()
                .any(|event| matches!(event, BackendEvent::TurnDone { .. }))
        );
    }

    #[test]
    fn models_come_from_model_list_with_their_own_efforts() {
        let h = start();
        let options = h.session.options();
        h.session.shutdown();
        let ids: Vec<_> = options
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect();
        assert_eq!(ids, ["gpt-mock", "gpt-mini"], "hidden models are skipped");
        assert_eq!(options.default_model.as_deref(), Some("gpt-mock"));
        assert_eq!(options.efforts, ["low", "medium", "high"]);
        assert_eq!(options.models[1].efforts, ["low"]);
        assert_eq!(options.models[0].label, "GPT Mock");
    }

    #[test]
    fn a_chosen_agent_is_named_in_the_prompt() {
        assert_eq!(prompt_text(None, "hi"), "hi");
        assert_eq!(
            prompt_text(Some("reviewer"), "hi"),
            "Use the `reviewer` custom agent for this request.\n\nhi"
        );
        assert_eq!(first_line_title("  Fix it  \nmore"), "Fix it");
    }

    #[test]
    fn thread_start_routes_approvals_to_the_reviewer() {
        let params = thread_start_params(
            Path::new("/work"),
            Some("auto_review"),
            Some("gpt-x"),
            false,
            &[],
            false,
        );
        assert_eq!(params["model"], "gpt-x");
        assert_eq!(params["approvalsReviewer"], "auto_review");
        assert_eq!(params["approvalPolicy"], "on-request");
        assert_eq!(params["sandbox"], "workspace-write");
        let manual = thread_start_params(Path::new("/work"), None, None, false, &[], false);
        assert_eq!(
            thread_start_params(Path::new("/work"), None, None, true, &[], false)["sandbox"],
            "read-only"
        );
        assert!(manual.get("approvalsReviewer").is_none());
        assert!(manual.get("model").is_none());
        assert!(manual.get("config").is_none());
    }

    #[test]
    fn the_other_repositories_of_a_workspace_become_writable_roots_unless_read_only() {
        let others = [PathBuf::from("/work/api"), PathBuf::from("/work/web")];
        let params = thread_start_params(Path::new("/work/app"), None, None, false, &others, false);
        assert_eq!(
            params["config"]["sandbox_workspace_write"]["writable_roots"],
            json!(["/work/api", "/work/web"])
        );
        let reading = thread_start_params(Path::new("/work/app"), None, None, true, &others, true);
        assert!(reading.get("config").is_none());
    }

    #[test]
    fn a_writing_agent_can_reach_the_local_api_through_the_sandbox() {
        let params = thread_start_params(Path::new("/work"), None, None, false, &[], true);
        assert_eq!(
            params["config"]["sandbox_workspace_write"]["network_access"],
            true
        );
        assert!(
            params["config"]["sandbox_workspace_write"]
                .get("writable_roots")
                .is_none()
        );
        let others = [PathBuf::from("/work/api")];
        let both = thread_start_params(Path::new("/work"), None, None, false, &others, true);
        assert_eq!(
            both["config"]["sandbox_workspace_write"]["writable_roots"],
            json!(["/work/api"])
        );
        assert_eq!(
            both["config"]["sandbox_workspace_write"]["network_access"],
            true
        );
        // Without the API nothing opens, and a read-only sandbox stays closed.
        assert!(
            thread_start_params(Path::new("/work"), None, None, false, &[], false)
                .get("config")
                .is_none()
        );
    }

    use std::sync::mpsc::{self, Receiver};
    use std::time::Instant;

    use super::*;

    struct Harness {
        session: Arc<dyn BackendSession>,
        events: Receiver<BackendEvent>,
    }

    fn start() -> Harness {
        start_resuming(None)
    }

    fn start_resuming(resume: Option<&str>) -> Harness {
        let backend = CodexBackend::with_command(
            PathBuf::from("python3"),
            vec![concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mock_codex.py").into()],
        );
        let (sender, events) = mpsc::channel();
        let sender = Mutex::new(sender);
        let session = backend
            .start(BackendContext {
                launch: None,
                reviewer: None,
                read_only: false,
                session_id: crate::domain::ids::SessionId::new(),
                cwd: std::env::temp_dir(),
                extra_dirs: Vec::new(),
                model: None,
                effort: None,
                agent: None,
                resume: resume.map(str::to_string),
                api: None,
                config: super::super::config::AgentConfiguration::default(),
                emit: Arc::new(move |event| {
                    let _ = sender.lock().send(event);
                }),
            })
            .expect("start mock codex");
        Harness { session, events }
    }

    fn said(h: &Harness, text: &str) -> Value {
        h.session.prompt(TurnId::new(), text).expect("prompt");
        let seen = h.until("turn done", is_turn_done);
        serde_json::from_str(&deltas(&seen)).expect("the mock echoes the input")
    }

    #[test]
    fn codex_does_not_offer_provider_commands() {
        let h = start();
        let commands = h.session.commands();
        h.session.shutdown();
        assert!(commands.is_empty());
    }

    #[test]
    fn a_provider_command_typed_as_a_message_is_not_rewritten() {
        let h = start();
        let input = said(&h, "/review-mock the diff");
        h.session.shutdown();
        assert_eq!(input[0]["text"], "/review-mock the diff");
        assert_eq!(input.as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn a_message_that_is_no_command_of_codex_goes_out_as_typed() {
        let h = start();
        let unknown = said(&h, "/nothing-like-this at all");
        let path = said(&h, "echo /etc/hosts please");
        h.session.shutdown();
        assert_eq!(unknown[0]["text"], "/nothing-like-this at all");
        assert_eq!(unknown.as_array().map(Vec::len), Some(1));
        assert_eq!(path[0]["text"], "echo /etc/hosts please");
    }

    #[test]
    #[ignore = "needs the codex CLI and python3"]
    fn the_real_codex_discovers_and_calls_the_configured_mcp() {
        use super::super::config::AgentConfiguration;

        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        let session = CodexBackend::new()
            .start_session(BackendContext {
                launch: Some(Launch {
                    env: vec![("CODEX_HOME".into(), cwd.join("account").display().to_string())],
                    ..Launch::default()
                }),
                read_only: true,
                reviewer: None,
                session_id: crate::domain::ids::SessionId::new(),
                cwd: cwd.clone(),
                extra_dirs: Vec::new(),
                model: None,
                effort: None,
                agent: None,
                resume: None,
                api: None,
                config: AgentConfiguration {
                    mcp_config_path: Some(cwd.join("agent-config/session.mcp.json")),
                    mcp_servers: serde_json::from_value(json!({
                        "ataraxia.probe": {
                            "command": "python3",
                            "args": [concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mcp_probe.py")]
                        }
                    })).unwrap(),
                    ..AgentConfiguration::default()
                },
                emit: Arc::new(|_| {}),
            })
            .expect("start real Codex");
        let client = session.shared.client.get().unwrap();
        let status = client.request(
            "mcpServerStatus/list",
            json!({"detail": "toolsAndAuthOnly"}),
            Some(HANDSHAKE_TIMEOUT),
        );
        let result = client.request(
            "mcpServer/tool/call",
            json!({
                "threadId": session.conversation().unwrap(),
                "server": "ataraxia.probe",
                "tool": "probe",
                "arguments": {}
            }),
            Some(HANDSHAKE_TIMEOUT),
        );
        session.shutdown();
        let status = status.expect("list process-wide MCP tools");
        assert_eq!(status["data"][0]["name"], "ataraxia.probe");
        assert!(status["data"][0]["tools"]["probe"].is_object(), "{status}");
        let result = result.expect("call the MCP tool in the active thread");
        assert_eq!(result["content"][0]["text"], "ataraxia-mcp-ok");
    }

    /// Codex's own skills show up as commands. Needs `codex` installed
    /// (`cargo test -- --ignored`).
    #[test]
    #[ignore = "needs the codex CLI"]
    fn the_real_cli_lists_its_skills_as_commands() {
        let (sender, _events) = mpsc::channel();
        let sender = Mutex::new(sender);
        let session = CodexBackend::new()
            .start(BackendContext {
                launch: None,
                reviewer: None,
                read_only: true,
                session_id: crate::domain::ids::SessionId::new(),
                cwd: std::env::temp_dir(),
                extra_dirs: Vec::new(),
                model: None,
                effort: None,
                agent: None,
                resume: None,
                api: None,
                config: super::super::config::AgentConfiguration::default(),
                emit: Arc::new(move |event| {
                    let _ = sender.lock().send(event);
                }),
            })
            .expect("start codex");
        let commands = session.commands();
        session.shutdown();
        assert!(commands.iter().all(|item| !item.name.is_empty()));
        eprintln!("{} commands, e.g. {:?}", commands.len(), commands.first());
    }

    #[test]
    fn a_thread_codex_still_has_is_picked_up_again() {
        let h = start_resuming(Some("thread-old"));
        assert!(h.session.resumed());
        assert_eq!(h.session.conversation().as_deref(), Some("thread-old"));
        h.session.shutdown();
    }

    #[test]
    fn a_thread_codex_lost_begins_a_new_one() {
        let h = start_resuming(Some("gone-thread"));
        assert!(!h.session.resumed());
        let started = h.session.conversation().expect("a thread");
        assert_ne!(started, "gone-thread");
        h.session.shutdown();
    }

    #[test]
    fn a_first_run_begins_a_thread_and_reports_it() {
        let h = start();
        assert!(!h.session.resumed());
        assert!(h.session.conversation().is_some());
        h.session.shutdown();
    }

    impl Harness {
        fn until(
            &self,
            what: &str,
            predicate: impl Fn(&BackendEvent) -> bool,
        ) -> Vec<BackendEvent> {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut seen = Vec::new();
            while Instant::now() < deadline {
                if let Ok(event) = self.events.recv_timeout(Duration::from_millis(50)) {
                    let done = predicate(&event);
                    seen.push(event);
                    if done {
                        return seen;
                    }
                }
            }
            panic!("timed out waiting for {what}; saw {seen:?}");
        }
    }

    fn is_turn_done(event: &BackendEvent) -> bool {
        matches!(event, BackendEvent::TurnDone { .. })
    }

    fn deltas(events: &[BackendEvent]) -> String {
        events
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn streams_agent_message_deltas() {
        let h = start();
        let turn = TurnId::new();
        h.session.prompt(turn, "say hi").expect("prompt");
        let seen = h.until("turn done", is_turn_done);
        assert_eq!(deltas(&seen), "Hello world");
        assert_eq!(
            seen.last(),
            Some(&BackendEvent::TurnDone {
                turn_id: turn,
                ok: true
            })
        );
        h.session.shutdown();
    }

    fn run_tool_turn(allow: bool) -> Vec<BackendEvent> {
        let h = start();
        h.session
            .prompt(TurnId::new(), "tool please")
            .expect("prompt");
        let mut seen = h.until("permission", |event| {
            matches!(event, BackendEvent::Permission { .. })
        });
        let request_id = match seen.last() {
            Some(BackendEvent::Permission { request_id, .. }) => *request_id,
            other => panic!("unexpected {other:?}"),
        };
        h.session
            .resolve_permission(&PermissionDecision {
                request_id,
                allow,
                remember: false,
                answers: Default::default(),
            })
            .expect("resolve");
        seen.extend(h.until("turn done", is_turn_done));
        h.session.shutdown();
        seen
    }

    #[test]
    fn accepted_command_reports_output() {
        let seen = run_tool_turn(true);
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Tool { name, input, .. } if name == "command" && input == "touch probe.txt"
        )));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Permission { detail, .. }
                if detail == "Allow running: touch probe.txt (needs to write)"
        )));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::ToolResult { ok: true, output, .. } if output == "created"
        )));
        assert_eq!(deltas(&seen), "All done.");
    }

    #[test]
    fn declined_command_fails_the_tool() {
        let seen = run_tool_turn(false);
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::ToolResult { ok: false, output, .. } if output.contains("declined")
        )));
    }

    #[test]
    fn interrupt_finishes_with_an_unsuccessful_turn() {
        let h = start();
        let turn = TurnId::new();
        h.session.prompt(turn, "hang").expect("prompt");
        h.until("first delta", |event| {
            matches!(event, BackendEvent::Delta { .. })
        });
        h.session.cancel().expect("cancel");
        let seen = h.until("turn done", is_turn_done);
        assert_eq!(
            seen.last(),
            Some(&BackendEvent::TurnDone {
                turn_id: turn,
                ok: false
            })
        );
        h.session.shutdown();
    }

    #[test]
    fn interrupt_stops_a_compaction_turn() {
        let h = start();
        let turn_id = TurnId::new();
        h.session.prompt(turn_id, "/compact").expect("compact");
        h.session.cancel().expect("cancel compact");
        let seen = h.until("compact turn done", is_turn_done);
        assert_eq!(
            seen.last(),
            Some(&BackendEvent::TurnDone { turn_id, ok: false })
        );
        h.session.shutdown();
    }

    #[test]
    fn crash_reports_stderr_and_marks_session_dead() {
        let h = start();
        h.session.prompt(TurnId::new(), "crash").expect("prompt");
        let seen = h.until("error", |event| matches!(event, BackendEvent::Error { .. }));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Error { message } if message.contains("codex exploded")
        )));
        let deadline = Instant::now() + Duration::from_secs(5);
        while h.session.is_alive() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!h.session.is_alive());
    }

    #[test]
    fn items_map_to_tool_summaries() {
        let file_change = json!({
            "type": "fileChange",
            "id": "f1",
            "changes": [{ "path": "a.rs", "kind": { "type": "update" } }],
            "status": "completed"
        });
        assert_eq!(
            item_summary(&file_change),
            Some(("file_change".into(), "update a.rs".into()))
        );
        assert_eq!(item_result(&file_change), ("update a.rs".into(), true));
        assert_eq!(
            item_summary(&json!({ "type": "agentMessage", "id": "m" })),
            None
        );
        let failed = json!({
            "type": "commandExecution",
            "aggregatedOutput": "oops",
            "exitCode": 2,
            "status": "completed"
        });
        assert_eq!(item_result(&failed), ("oops\n(exit code 2)".into(), false));
    }
}
