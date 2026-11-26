//! OpenCode through the Agent Client Protocol (`opencode acp`, JSON-RPC over stdio).
//!
//! Frame shapes follow OpenCode's real ACP traffic: `session/update` notifications
//! (`agent_message_chunk`, `tool_call`, `tool_call_update`, ...) and
//! `session/request_permission` requests that the host answers with an option id.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde_json::{Map, Value, json};

use super::backend::{
    AgentBackend, BackendContext, BackendEvent, BackendSession, Emitter, Launch, SubagentRoute,
    api_env, compose_env, profile_args, profile_program, truncate_output,
};
use super::config::prepare_private_dir;
use super::process::{ExitInfo, SpawnSpec, resolve_binary};
use super::rpc::{Incoming, RpcClient};
use crate::domain::agent::{AgentChoice, ModelChoice, SessionOptions, SlashCommand};
use crate::domain::ids::TurnId;
use crate::domain::{
    Error, ErrorCode, PermissionDecision, PermissionRequestId, Result, SubagentUpdate, ToolCallId,
};

const BINARY_NAME: &str = "opencode";
const OVERRIDE_ENV: &str = "ATARAXIA_OPENCODE_BIN";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a prompt or a setting waits for a session still opening: `session/new` and the
/// three settings applied after it, each within its own timeout.
const OPEN_TIMEOUT: Duration = Duration::from_secs(4 * 60);

enum Launcher {
    Resolve,
    Fixed { program: PathBuf, args: Vec<String> },
}

pub struct OpenCodeBackend {
    launcher: Launcher,
}

impl OpenCodeBackend {
    pub fn new() -> Self {
        Self {
            launcher: Launcher::Resolve,
        }
    }

    /// Runs an arbitrary ACP-speaking program instead of `opencode acp` (tests).
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
                    .map(|program| (program, profile_args(launch, vec!["acp".to_string()])))
                    .ok_or_else(|| {
                        format!(
                            "opencode CLI not found. Install it or set {OVERRIDE_ENV} to its path."
                        )
                    })
            }
        }
    }
}

impl Default for OpenCodeBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentBackend for OpenCodeBackend {
    fn availability(&self) -> std::result::Result<(), String> {
        self.command(None).map(|_| ())
    }

    fn start(&self, ctx: BackendContext) -> Result<Arc<dyn BackendSession>> {
        let (program, args) = self
            .command(ctx.launch.as_ref())
            .map_err(|message| Error::new(ErrorCode::Unsupported, message))?;
        let mut env = compose_env(
            api_env(ctx.session_id, ctx.api.as_ref()),
            ctx.launch.as_ref(),
        );
        env.retain(|(key, _)| {
            !matches!(
                key.as_str(),
                "OPENCODE_CONFIG"
                    | "OPENCODE_CONFIG_CONTENT"
                    | "OPENCODE_CONFIG_DIR"
                    | "OPENCODE_PERMISSION"
            )
        });
        if let Some(config_path) = &ctx.config.mcp_config_path {
            if let Some(config_root) = config_path
                .parent()
                .map(|path| path.join(ctx.session_id.0.to_string()).join("opencode-xdg"))
            {
                let opencode_config_dir = config_root.join("opencode");
                prepare_private_dir(&opencode_config_dir)?;
                env.extend([
                    (
                        "XDG_CONFIG_HOME".into(),
                        config_root.to_string_lossy().into_owned(),
                    ),
                    (
                        "OPENCODE_CONFIG_DIR".into(),
                        opencode_config_dir.to_string_lossy().into_owned(),
                    ),
                    ("OPENCODE_DISABLE_PROJECT_CONFIG".into(), "1".into()),
                    ("OPENCODE_DISABLE_CLAUDE_CODE".into(), "1".into()),
                    ("OPENCODE_DISABLE_EXTERNAL_SKILLS".into(), "1".into()),
                    ("OPENCODE_PURE".into(), "1".into()),
                ]);
            }
        }
        let skill_roots: Vec<String> = ctx
            .config
            .skill_roots
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let mcp_servers = opencode_config_mcp_servers(&ctx.config.mcp_servers)?;
        let mut config = json!({
            "skills": skill_roots,
            "permissions": opencode_skill_permissions(&ctx.config.skills)
        });
        if !mcp_servers.is_empty() {
            config["mcp"] = json!({ "servers": mcp_servers });
        }
        env.push(("OPENCODE_CONFIG_CONTENT".into(), config.to_string()));
        launch_acp(
            Dialect::OpenCode,
            ctx,
            program,
            args,
            env,
            vec![
                "OPENCODE_CONFIG".into(),
                "OPENCODE_CONFIG_CONTENT".into(),
                "OPENCODE_CONFIG_DIR".into(),
                "OPENCODE_PERMISSION".into(),
            ],
        )
    }
}

/// The ACP harnesses this engine speaks to. They share the protocol and differ in the few places
/// each agent's own extensions show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Dialect {
    OpenCode,
    Cursor,
}

impl Dialect {
    /// How the harness is called in messages to the person.
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::OpenCode => "opencode",
            Self::Cursor => "cursor-agent",
        }
    }

    /// Cursor lists model, effort and fast as separate options instead of one selector per variant.
    fn client_meta(self) -> Option<Value> {
        match self {
            Self::OpenCode => None,
            Self::Cursor => Some(json!({ "parameterizedModelPicker": true })),
        }
    }

    /// OpenCode sets remote and cwd-bound MCP servers up in its own config; Cursor takes every
    /// server over ACP.
    fn handles_mcp_natively(self, config: &Value) -> bool {
        self == Self::OpenCode && native_mcp(config)
    }

    /// The modes in which the agent does not write.
    fn read_only_modes(self) -> &'static [&'static str] {
        match self {
            Self::OpenCode => &["plan"],
            Self::Cursor => &["plan", "ask"],
        }
    }

    /// The mode a session that only investigates runs in, among the ones the agent offers.
    fn read_only_mode(self, offered: &[ConfigValue]) -> Option<String> {
        if self == Self::OpenCode {
            return Some("plan".into());
        }
        self.read_only_modes()
            .iter()
            .find(|wanted| offered.iter().any(|value| value.value == **wanted))
            .map(|wanted| (*wanted).to_string())
    }

    /// A start that failed for lack of a login says how to sign in.
    fn sign_in_hint(self, message: String) -> String {
        let signed_out = message.to_lowercase().contains("auth");
        match self {
            Self::Cursor if signed_out => {
                format!("{message}. Sign in once with `cursor-agent login`.")
            }
            _ => message,
        }
    }
}

/// Spawns the agent over ACP, opens (or picks up again) its session and applies the saved
/// model, effort and mode.
///
/// An agent that cannot pick a session up again (Cursor) opens it in the background: its first
/// `session/new` takes seconds, and the chat need not wait for it. Prompts and settings wait
/// until the session is open; a session that fails to open says why and ends its process, so
/// the next message starts it again. An agent that can resume opens it before returning, since
/// the host keeps the id it reports and asks right away whether the old one was picked up.
pub(super) fn launch_acp(
    dialect: Dialect,
    ctx: BackendContext,
    program: PathBuf,
    args: Vec<String>,
    env: Vec<(String, String)>,
    env_remove: Vec<String>,
) -> Result<Arc<dyn BackendSession>> {
    let shared = Arc::new(AcpShared {
        dialect,
        config: Mutex::new(Vec::new()),
        initial: Mutex::new(HashMap::new()),
        emit: Arc::clone(&ctx.emit),
        client: OnceLock::new(),
        acp_session_id: OnceLock::new(),
        exit: Mutex::new(None),
        state: Mutex::new(AcpState::default()),
        opening: Mutex::new(Opening::Pending),
        opened: Condvar::new(),
        read_only: ctx.read_only,
    });
    let handler_shared = Arc::clone(&shared);
    let mut client_capabilities = json!({
        "fs": { "readTextFile": false, "writeTextFile": false },
        "terminal": false
    });
    if let Some(meta) = dialect.client_meta() {
        client_capabilities["_meta"] = meta;
    }
    let client = RpcClient::spawn(
        &SpawnSpec {
            program,
            args,
            cwd: ctx.cwd.clone(),
            env,
            env_remove,
        },
        true,
        move |incoming| handler_shared.on_incoming(incoming),
    )?;
    let _ = shared.client.set(Arc::clone(&client));

    let hello = client.request(
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": client_capabilities,
            "clientInfo": {
                "name": "ataraxia",
                "title": "Ataraxia",
                "version": env!("CARGO_PKG_VERSION")
            }
        }),
        Some(HANDSHAKE_TIMEOUT),
    );
    let opener = hello.and_then(|hello| Opener::new(dialect, &hello, &ctx));
    let opener = match opener {
        Ok(opener) => opener,
        Err(error) => return Err(shared.fail_start(&client, error)),
    };
    if !opener.can_resume {
        let background = Arc::clone(&shared);
        let background_client = Arc::clone(&client);
        thread::spawn(move || match opener.open(&background) {
            Ok(_) => background.settle(Ok(())),
            Err(error) => background.fail_open(&background_client, error),
        });
        return Ok(Arc::new(AcpSession {
            shared,
            resumed: false,
        }));
    }
    match opener.open(&shared) {
        Ok(resumed) => {
            shared.settle(Ok(()));
            Ok(Arc::new(AcpSession { shared, resumed }))
        }
        Err(error) => Err(shared.fail_start(&client, error)),
    }
}

/// What opening the session needs, as learnt from `initialize` and the chat's settings.
struct Opener {
    can_resume: bool,
    /// The session of the last run, when the agent can pick one up without replaying it
    /// (replayed messages would be shown twice).
    resume: Option<String>,
    cwd: String,
    mcp_servers: Vec<Value>,
    additional_directories: Vec<String>,
    read_only: bool,
    model: Option<String>,
    effort: Option<String>,
    agent: Option<String>,
}

impl Opener {
    fn new(dialect: Dialect, hello: &Value, ctx: &BackendContext) -> Result<Self> {
        let can_resume = hello
            .pointer("/agentCapabilities/sessionCapabilities/resume")
            .is_some_and(|value| !value.is_null());
        let agent_capabilities = hello.get("agentCapabilities");
        let capable = |pointer: &str| {
            agent_capabilities
                .and_then(|value| value.pointer(pointer))
                .is_some_and(|value| value == true)
        };
        let mcp_servers = acp_mcp_servers(
            dialect,
            &ctx.config.mcp_servers,
            capable("/mcpCapabilities/http"),
            capable("/mcpCapabilities/sse"),
        )?;
        let supports_additional_directories = agent_capabilities
            .and_then(|value| value.pointer("/sessionCapabilities/additionalDirectories"))
            .is_some_and(|value| !value.is_null() && value != false);
        let additional_directories = if supports_additional_directories {
            session_directories(&ctx.cwd, &ctx.extra_dirs, &ctx.config.skill_roots)
        } else {
            Vec::new()
        };
        Ok(Self {
            can_resume,
            resume: ctx.resume.clone().filter(|_| can_resume),
            cwd: ctx.cwd.to_string_lossy().into_owned(),
            mcp_servers,
            additional_directories,
            read_only: ctx.read_only,
            model: ctx.model.clone(),
            effort: ctx.effort.clone(),
            agent: ctx.agent.clone(),
        })
    }

    fn session_params(&self) -> Value {
        let mut params = json!({ "cwd": self.cwd, "mcpServers": self.mcp_servers });
        if !self.additional_directories.is_empty() {
            params["additionalDirectories"] = json!(self.additional_directories);
        }
        params
    }

    /// Picks the old session up or begins a new one, then applies the saved settings. True when
    /// the old one was picked up; a lost one begins a new session.
    fn open(&self, shared: &AcpShared) -> Result<bool> {
        let client = shared
            .client
            .get()
            .ok_or_else(|| Error::new(ErrorCode::Agent, "the agent process is gone"))?;
        let mut resumed = false;
        if let Some(wanted) = &self.resume {
            let mut params = self.session_params();
            params["sessionId"] = json!(wanted);
            if let Ok(picked) = client.request("session/resume", params, Some(HANDSHAKE_TIMEOUT)) {
                let _ = shared.acp_session_id.set(wanted.clone());
                if let Some(options) = picked.get("configOptions") {
                    shared.remember_config(parse_config_options(options), Defaults::All);
                }
                resumed = true;
            }
        }
        if !resumed {
            let created = client.request(
                "session/new",
                self.session_params(),
                Some(HANDSHAKE_TIMEOUT),
            )?;
            let session_id = created
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::new(ErrorCode::Agent, "session/new returned no sessionId"))?;
            let _ = shared.acp_session_id.set(session_id.to_string());
            if let Some(options) = created.get("configOptions") {
                shared.remember_config(parse_config_options(options), Defaults::All);
            }
        }
        // Starting anyway would let a session that must not write do so.
        shared.mode_for(self.agent.as_deref())?;
        // Best effort: a stale saved model or agent must not stop the chat from opening.
        let _ = shared.apply(
            self.model.as_deref(),
            self.effort.as_deref(),
            self.agent.as_deref(),
        );
        if self.read_only && !shared.runs_read_only() {
            return Err(Error::new(
                ErrorCode::Unsupported,
                format!(
                    "{} did not switch to a read-only mode",
                    shared.dialect.name()
                ),
            ));
        }
        Ok(resumed)
    }
}

fn opencode_skill_permissions(skills: &[super::config::SkillDefinition]) -> Vec<Value> {
    let mut permissions = vec![json!({
        "action": "skill",
        "resource": "*",
        "effect": "deny"
    })];
    permissions.extend(skills.iter().map(|skill| {
        json!({
            "action": "skill",
            "resource": skill.id,
            "effect": "allow"
        })
    }));
    permissions
}

/// OpenCode ACP's MCP entry omits `cwd`, so entries with an explicit working directory use its
/// native config format instead.
/// A remote server goes through OpenCode's own config, where OpenCode signs in to it (OAuth)
/// and keeps the sign-in; over ACP it would need a transport the agent may not offer, and a
/// server that asks for a sign-in would never get one.
fn is_remote(config: &Value) -> bool {
    config.get("url").is_some() && config.get("command").is_none()
}

/// Whether a server is set up through OpenCode's own config rather than ACP.
fn native_mcp(config: &Value) -> bool {
    is_remote(config) || (config.get("command").is_some() && config.get("cwd").is_some())
}

fn opencode_config_mcp_servers(servers: &Map<String, Value>) -> Result<Map<String, Value>> {
    let mut configured = Map::new();
    for (name, config) in servers {
        if is_remote(config) {
            let url = config
                .get("url")
                .and_then(Value::as_str)
                .filter(|url| !url.is_empty())
                .ok_or_else(|| {
                    Error::new(
                        ErrorCode::Invalid,
                        format!("MCP server {name} url must be a non-empty string"),
                    )
                })?;
            let mut server = json!({ "type": "remote", "url": url });
            if let Some(headers) = config.get("headers") {
                if !headers
                    .as_object()
                    .is_some_and(|values| values.values().all(Value::is_string))
                {
                    return Err(Error::new(
                        ErrorCode::Invalid,
                        format!("MCP server {name} headers must be an object of strings"),
                    ));
                }
                server["headers"] = headers.clone();
            }
            configured.insert(name.clone(), server);
            continue;
        }
        if !native_mcp(config) {
            continue;
        }
        let command = config
            .get("command")
            .and_then(Value::as_str)
            .filter(|command| !command.is_empty())
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::Invalid,
                    format!("MCP server {name} command must be a non-empty string"),
                )
            })?;
        let cwd = config
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty())
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::Invalid,
                    format!("MCP server {name} cwd must be a non-empty string"),
                )
            })?;
        let mut command_args = vec![Value::String(command.to_string())];
        if let Some(args) = config.get("args") {
            let args = args.as_array().ok_or_else(|| {
                Error::new(
                    ErrorCode::Invalid,
                    format!("MCP server {name} args must be an array of strings"),
                )
            })?;
            if args.iter().any(|arg| !arg.is_string()) {
                return Err(Error::new(
                    ErrorCode::Invalid,
                    format!("MCP server {name} args must be an array of strings"),
                ));
            }
            command_args.extend(args.iter().cloned());
        }
        let mut server = json!({
            "type": "local",
            "command": command_args,
            "cwd": cwd
        });
        if let Some(environment) = config.get("env") {
            if !environment
                .as_object()
                .is_some_and(|values| values.values().all(Value::is_string))
            {
                return Err(Error::new(
                    ErrorCode::Invalid,
                    format!("MCP server {name} env must be an object of strings"),
                ));
            }
            server["environment"] = environment.clone();
        }
        configured.insert(name.clone(), server);
    }
    Ok(configured)
}

#[derive(Debug, Clone)]
struct AcpOption {
    id: String,
    kind: String,
}

/// Translates portable MCP entries into the active ACP v1 transport shapes.
fn acp_mcp_servers(
    dialect: Dialect,
    servers: &Map<String, Value>,
    supports_http: bool,
    supports_sse: bool,
) -> Result<Vec<Value>> {
    servers
        .iter()
        .filter(|(_, config)| !dialect.handles_mcp_natively(config))
        .map(|(name, config)| {
            let mut entry = Map::new();
            entry.insert("name".into(), Value::String(name.clone()));
            if let Some(command) = config.get("command").and_then(Value::as_str) {
                entry.insert("command".into(), Value::String(command.to_string()));
                let args = config.get("args").cloned().unwrap_or_else(|| json!([]));
                entry.insert("args".into(), args);
                let env = match config.get("env") {
                    Some(env) => acp_pairs(env, "env", name)?,
                    None => json!([]),
                };
                entry.insert("env".into(), env);
            } else if let Some(url) = config.get("url").and_then(Value::as_str) {
                let transport = config
                    .get("type")
                    .or_else(|| config.get("transport"))
                    .and_then(Value::as_str)
                    .unwrap_or("http");
                match transport {
                    "http" if supports_http => {
                        entry.insert("type".into(), Value::String("http".into()));
                    }
                    "sse" if supports_sse => {
                        entry.insert("type".into(), Value::String("sse".into()));
                    }
                    "http" | "sse" => {
                        return Err(Error::new(
                            ErrorCode::Unsupported,
                            format!(
                                "{} does not support the {transport} MCP transport over ACP",
                                dialect.name()
                            ),
                        ));
                    }
                    _ => {
                        return Err(Error::new(
                            ErrorCode::Invalid,
                            format!("MCP server {name} has an unsupported transport"),
                        ));
                    }
                }
                entry.insert("url".into(), Value::String(url.to_string()));
                // ACP requires the list even when it is empty; Cursor refuses the whole session
                // ("Invalid params") for a remote server without it.
                let headers = match config.get("headers") {
                    Some(headers) => acp_pairs(headers, "headers", name)?,
                    None => json!([]),
                };
                entry.insert("headers".into(), headers);
            } else {
                return Err(Error::new(
                    ErrorCode::Invalid,
                    format!("MCP server {name} needs either command or url"),
                ));
            }
            Ok(Value::Object(entry))
        })
        .collect()
}

fn acp_pairs(value: &Value, key: &str, server: &str) -> Result<Value> {
    let values = value.as_object().ok_or_else(|| {
        Error::new(
            ErrorCode::Invalid,
            format!("MCP server {server} {key} must be an object"),
        )
    })?;
    values
        .iter()
        .map(|(name, value)| {
            let value = value.as_str().ok_or_else(|| {
                Error::new(
                    ErrorCode::Invalid,
                    format!("MCP server {server} {key}.{name} must be a string"),
                )
            })?;
            Ok(json!({ "name": name, "value": value }))
        })
        .collect::<Result<Vec<_>>>()
        .map(Value::Array)
}

fn session_directories(
    cwd: &std::path::Path,
    extra_dirs: &[PathBuf],
    skill_roots: &[PathBuf],
) -> Vec<String> {
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut directories: Vec<String> = extra_dirs
        .iter()
        .chain(skill_roots)
        .filter_map(|path| {
            let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
            (path.is_dir() && path != cwd).then(|| path.to_string_lossy().into_owned())
        })
        .collect();
    directories.sort();
    directories.dedup();
    directories
}

struct QueuedPermission {
    request_id: PermissionRequestId,
    turn_id: TurnId,
    rpc_id: Value,
    tool_name: String,
    detail: String,
    options: Vec<AcpOption>,
    /// Questions the agent put to the person (Cursor); the reply is built from the answers.
    questions: Vec<crate::domain::PermissionQuestion>,
    asked: Option<super::cursor::Questions>,
}

struct ToolMeta {
    id: ToolCallId,
    name: String,
    input: String,
}

#[derive(Default)]
struct AcpState {
    turn: Option<TurnId>,
    cancel_requested: bool,
    rate_attempts: u32,
    tools: HashMap<String, ToolMeta>,
    queue: VecDeque<QueuedPermission>,
    active: Option<QueuedPermission>,
    /// Tool calls made inside child sessions → the call id shown in the subagent transcript.
    child_calls: HashMap<String, ToolCallId>,
    /// Child sessions seen so far (id → title), so updates addressed to one are recognised
    /// even without the `_meta` marker.
    children: HashMap<String, String>,
    /// The commands the agent runs from a `/name` message, as it last said.
    commands: Vec<SlashCommand>,
}

/// The agent's own list: a name, a description and, for one that takes arguments, a hint.
fn parse_commands(list: &[Value]) -> Vec<SlashCommand> {
    list.iter()
        .filter_map(|node| {
            let name = node.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() {
                return None;
            }
            Some(SlashCommand {
                name: name.trim_start_matches('/').to_string(),
                description: node
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                hint: node
                    .pointer("/input/hint")
                    .and_then(Value::as_str)
                    .filter(|hint| !hint.trim().is_empty())
                    .map(str::to_string),
                source: None,
            })
        })
        .collect()
}

/// A subagent's child session, as marked by OpenCode on its updates.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ChildSession {
    id: String,
    title: String,
}

fn child_session(holder: &Value) -> Option<ChildSession> {
    let meta = holder.get("_meta")?.get("opencode/child-session")?;
    let id = meta.get("id")?.as_str()?.to_string();
    let title = meta
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("Subagent")
        .to_string();
    Some(ChildSession { id, title })
}

/// One selectable value of an ACP session config option.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfigValue {
    value: String,
    name: String,
    description: Option<String>,
}

/// An ACP session config option (`model`, `effort`, `mode`, ...), flattened.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfigOption {
    id: String,
    category: String,
    current: String,
    values: Vec<ConfigValue>,
}

impl ConfigOption {
    /// Matches by ACP category (`model`, `thought_level`, `mode`), falling back to the id.
    fn is(&self, category: &str, id: &str) -> bool {
        self.category == category || (self.category.is_empty() && self.id == id)
    }

    /// A thinking switch (`false`/`true`) rather than a list of levels.
    fn is_switch(&self) -> bool {
        self.values.len() == 2
            && self
                .values
                .iter()
                .all(|item| item.value == "false" || item.value == "true")
    }

    fn offers(&self, value: &str) -> bool {
        self.values.iter().any(|item| item.value == value)
    }
}

/// Effort choices for a thinking switch: `off` turns thinking off, `on` turns it on where the
/// model has no levels (with levels, picking one turns it on).
const THINKING_OFF: &str = "off";
const THINKING_ON: &str = "on";

/// How the session sets reasoning: a list of levels, a thinking switch, or both. Cursor names the
/// levels differently per model (`effort`, `reasoning`, `reasoning_effort`) and gives some Claude
/// models a `thinking` switch next to them, all under the `thought_level` category.
struct Reasoning {
    levels: Option<ConfigOption>,
    switch: Option<ConfigOption>,
}

impl Reasoning {
    fn of(config: &[ConfigOption]) -> Self {
        let offered: Vec<&ConfigOption> = config
            .iter()
            .filter(|option| option.is("thought_level", "effort"))
            .collect();
        Self {
            levels: offered
                .iter()
                .find(|option| !option.is_switch())
                .map(|option| (*option).clone()),
            switch: offered
                .iter()
                .find(|option| option.is_switch())
                .map(|option| (*option).clone()),
        }
    }

    /// What the person picks from, without the explicit `default` entry.
    fn choices(&self) -> Vec<String> {
        let mut choices = Vec::new();
        if self.switch.is_some() {
            choices.push(THINKING_OFF.to_string());
        }
        match &self.levels {
            Some(levels) => choices.extend(
                levels
                    .values
                    .iter()
                    .map(|item| item.value.clone())
                    .filter(|value| value != "default"),
            ),
            None if self.switch.is_some() => choices.push(THINKING_ON.to_string()),
            None => {}
        }
        choices
    }
}

/// Which current values become the defaults that `None` goes back to.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Defaults {
    /// The session just opened: all of them.
    All,
    /// The model changed: the options that depend on it start at the new model's own values.
    OfModel,
    /// Only options not seen before.
    New,
}

fn parse_config_options(value: &Value) -> Vec<ConfigOption> {
    let Some(options) = value.as_array() else {
        return Vec::new();
    };
    options
        .iter()
        .filter(|option| {
            option
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("select")
                == "select"
        })
        .filter_map(|option| {
            let id = option.get("id")?.as_str()?.to_string();
            let current = option.get("currentValue")?.as_str()?.to_string();
            let category = option
                .get("category")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let mut values = Vec::new();
            let mut push = |item: &Value| {
                if let Some(value) = item.get("value").and_then(Value::as_str) {
                    values.push(ConfigValue {
                        value: value.to_string(),
                        name: item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or(value)
                            .to_string(),
                        description: item
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    });
                }
            };
            for entry in option.get("options")?.as_array()? {
                // Either a flat list of values or a list of groups of values.
                match entry.get("options").and_then(Value::as_array) {
                    Some(group) => group.iter().for_each(&mut push),
                    None => push(entry),
                }
            }
            Some(ConfigOption {
                id,
                category,
                current,
                values,
            })
        })
        .collect()
}

struct AcpShared {
    dialect: Dialect,
    /// Config options as last reported, and the values the session started with.
    config: Mutex<Vec<ConfigOption>>,
    initial: Mutex<HashMap<String, String>>,
    emit: Emitter,
    client: OnceLock<Arc<RpcClient>>,
    acp_session_id: OnceLock<String>,
    exit: Mutex<Option<ExitInfo>>,
    state: Mutex<AcpState>,
    opening: Mutex<Opening>,
    opened: Condvar,
    /// Only investigates: it never runs in a mode that writes.
    read_only: bool,
}

/// Where opening the agent's session stands.
enum Opening {
    Pending,
    Open,
    /// Why it could not open, already said to the person.
    Failed(String),
}

impl AcpShared {
    fn settle(&self, outcome: std::result::Result<(), String>) {
        *self.opening.lock() = match outcome {
            Ok(()) => Opening::Open,
            Err(message) => Opening::Failed(message),
        };
        self.opened.notify_all();
    }

    /// Waits for the session to open; why it did not, otherwise.
    fn wait_open(&self) -> std::result::Result<(), String> {
        let deadline = Instant::now() + OPEN_TIMEOUT;
        let mut opening = self.opening.lock();
        loop {
            match &*opening {
                Opening::Open => return Ok(()),
                Opening::Failed(message) => return Err(message.clone()),
                Opening::Pending => {
                    if self.opened.wait_until(&mut opening, deadline).timed_out() {
                        return Err(format!(
                            "{} took too long to open its session",
                            self.dialect.name()
                        ));
                    }
                }
            }
        }
    }

    /// Why opening failed, as the person reads it: how the process ended, if it did, and how to
    /// sign in when that was the cause.
    fn failure(&self, error: Error) -> Error {
        match error.code {
            ErrorCode::Unsupported => error,
            _ => Error::new(
                ErrorCode::Agent,
                self.dialect
                    .sign_in_hint(self.with_exit_info(error.message)),
            ),
        }
    }

    /// A start that failed before returning: the caller reports the error.
    fn fail_start(&self, client: &RpcClient, error: Error) -> Error {
        let error = self.failure(error);
        self.settle(Err(error.message.clone()));
        client.kill();
        error
    }

    /// An opening in the background that failed: the chat is told, the process ends and the next
    /// message starts it again.
    fn fail_open(&self, client: &RpcClient, error: Error) {
        // A process that ended has said so already.
        let reported = self.exit.lock().is_some();
        let message = self.failure(error).message;
        self.settle(Err(message.clone()));
        client.kill();
        if !reported {
            (self.emit)(BackendEvent::Error { message });
        }
    }

    fn remember_config(&self, options: Vec<ConfigOption>, defaults: Defaults) {
        {
            let mut initial = self.initial.lock();
            for option in &options {
                let bound_to_model = !option.is("model", "model") && !option.is("mode", "mode");
                if defaults == Defaults::All || (defaults == Defaults::OfModel && bound_to_model) {
                    initial.insert(option.id.clone(), option.current.clone());
                } else {
                    initial
                        .entry(option.id.clone())
                        .or_insert_with(|| option.current.clone());
                }
            }
        }
        *self.config.lock() = options;
    }

    /// The mode to run in for the one wanted (`None` is the default). A read-only session only
    /// ever runs in a mode that does not write, whatever was chosen.
    fn mode_for(&self, agent: Option<&str>) -> Result<Option<String>> {
        if !self.read_only {
            return Ok(agent.map(str::to_string));
        }
        if let Some(agent) = agent.filter(|agent| self.dialect.read_only_modes().contains(agent)) {
            return Ok(Some(agent.to_string()));
        }
        self.dialect
            .read_only_mode(&self.mode_values())
            .map(Some)
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::Unsupported,
                    format!(
                        "{} offers no read-only mode (plan or ask)",
                        self.dialect.name()
                    ),
                )
            })
    }

    /// False when the session reports a mode that writes.
    fn runs_read_only(&self) -> bool {
        self.config
            .lock()
            .iter()
            .find(|option| option.is("mode", "mode"))
            .is_none_or(|option| {
                self.dialect
                    .read_only_modes()
                    .contains(&option.current.as_str())
            })
    }

    /// The modes the agent offers, as last reported.
    fn mode_values(&self) -> Vec<ConfigValue> {
        self.config
            .lock()
            .iter()
            .find(|option| option.is("mode", "mode"))
            .map(|option| option.values.clone())
            .unwrap_or_default()
    }

    fn option_id(&self, category: &str, id: &str) -> Option<String> {
        self.config
            .lock()
            .iter()
            .find(|option| option.is(category, id))
            .map(|option| option.id.clone())
    }

    /// Sets one config option; the reply carries the complete, updated list.
    fn set_config(&self, config_id: &str, value: &str) -> Result<()> {
        let (Some(client), Some(session_id)) = (self.client.get(), self.acp_session_id.get())
        else {
            return Err(Error::new(
                ErrorCode::Agent,
                format!("{} is not running", self.dialect.name()),
            ));
        };
        let reply = client.request(
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": config_id, "value": value }),
            Some(HANDSHAKE_TIMEOUT),
        )?;
        if let Some(options) = reply.get("configOptions") {
            let model = self
                .option_id("model", "model")
                .is_some_and(|model| model == config_id);
            let defaults = if model {
                Defaults::OfModel
            } else {
                Defaults::New
            };
            self.remember_config(parse_config_options(options), defaults);
        }
        Ok(())
    }

    /// Sets an option to `target` (`None`: back to its default) unless it already has it.
    fn set_to(&self, config_id: &str, target: Option<&str>) -> Result<()> {
        let target = match target {
            Some(value) => value.to_string(),
            None => match self.initial.lock().get(config_id) {
                Some(value) => value.clone(),
                None => return Ok(()),
            },
        };
        let current = self
            .config
            .lock()
            .iter()
            .find(|option| option.id == config_id)
            .map(|option| option.current.clone());
        if current.as_deref() == Some(target.as_str()) {
            return Ok(());
        }
        self.set_config(config_id, &target)
    }

    /// Moves the session to the wanted model, agent and effort; `None` means the default.
    fn apply(&self, model: Option<&str>, effort: Option<&str>, agent: Option<&str>) -> Result<()> {
        // Model first: the reasoning options on offer depend on it.
        if let Some(config_id) = self.option_id("model", "model") {
            self.set_to(&config_id, model)?;
        }
        if let Some(config_id) = self.option_id("mode", "mode") {
            let mode = self.mode_for(agent)?;
            self.set_to(&config_id, mode.as_deref())?;
        }
        self.apply_effort(effort)
    }

    fn apply_effort(&self, effort: Option<&str>) -> Result<()> {
        let reasoning = Reasoning::of(&self.config.lock());
        let Some(effort) = effort else {
            if let Some(switch) = &reasoning.switch {
                self.set_to(&switch.id, None)?;
            }
            if let Some(levels) = &reasoning.levels {
                // OpenCode's levels have an explicit `default` value.
                let default = (self.dialect == Dialect::OpenCode).then_some("default");
                self.set_to(&levels.id, default)?;
            }
            return Ok(());
        };
        match (&reasoning.switch, &reasoning.levels) {
            (Some(switch), _) if effort == THINKING_OFF => self.set_to(&switch.id, Some("false")),
            (Some(switch), None) if effort == THINKING_ON => self.set_to(&switch.id, Some("true")),
            (switch, Some(levels)) if levels.offers(effort) => {
                if let Some(switch) = switch {
                    self.set_to(&switch.id, Some("true"))?;
                }
                // Turning thinking on may list the levels anew.
                let levels = Reasoning::of(&self.config.lock())
                    .levels
                    .map_or_else(|| levels.id.clone(), |levels| levels.id);
                self.set_to(&levels, Some(effort))
            }
            // A level this model does not have (left from another model): it keeps its own.
            _ => Ok(()),
        }
    }

    fn with_exit_info(&self, message: String) -> String {
        match self.exit.lock().as_ref() {
            Some(info) => info.describe(self.dialect.name()),
            None => message,
        }
    }

    fn on_incoming(&self, incoming: Incoming) {
        match incoming {
            Incoming::Notification { method, params } => {
                if method == "session/update" {
                    if let Some(update) = params.get("update") {
                        // Child (subagent) sessions ride on the prompt's session with a marker,
                        // or arrive under their own session id once prompted directly.
                        let child = child_session(&params)
                            .or_else(|| child_session(update))
                            .or_else(|| self.known_child(&params));
                        match child {
                            Some(child) => self.on_child_update(&child, update),
                            None => self.on_update(update),
                        }
                    }
                }
            }
            Incoming::Request { id, method, params } => {
                if self.dialect == Dialect::Cursor && self.on_cursor_request(&id, &method, &params)
                {
                    return;
                }
                if method == "session/request_permission" {
                    self.on_permission(id, &params);
                } else if let Some(client) = self.client.get() {
                    let _ = client.respond_error(&id, -32601, "method not supported by Ataraxia");
                }
            }
            Incoming::Closed(info) => {
                let message = info.describe(self.dialect.name());
                *self.exit.lock() = Some(info);
                // Ended because its session could not open, which the chat was told already.
                if matches!(*self.opening.lock(), Opening::Failed(_)) {
                    return;
                }
                (self.emit)(BackendEvent::Error { message });
            }
        }
    }

    /// Cursor's own requests (questions, plans, reports). False when the request is none of them.
    fn on_cursor_request(&self, id: &Value, method: &str, params: &Value) -> bool {
        use super::cursor::{Handled, classify};
        let Some(handled) = classify(method, params) else {
            return false;
        };
        match handled {
            Err(message) => {
                if let Some(client) = self.client.get() {
                    let _ = client.respond_error(id, -32602, &message);
                }
            }
            Ok(Handled::Reply(reply)) => self.answer(id, reply),
            Ok(Handled::Plan { reply, text }) => {
                self.answer(id, reply);
                if let Some(turn_id) = self.state.lock().turn {
                    (self.emit)(BackendEvent::Delta {
                        turn_id,
                        text: format!("\n\n**Plan**\n\n{text}\n"),
                    });
                }
            }
            Ok(Handled::Ask { questions, keep }) => {
                let mut state = self.state.lock();
                let Some(turn_id) = state.turn else {
                    // Nothing is running: refuse rather than leave the agent hanging.
                    drop(state);
                    self.answer(id, json!({ "outcome": { "outcome": "cancelled" } }));
                    return true;
                };
                state.queue.push_back(QueuedPermission {
                    request_id: PermissionRequestId::new(),
                    turn_id,
                    rpc_id: id.clone(),
                    tool_name: "Question".into(),
                    detail: questions
                        .first()
                        .map(|question| question.question.clone())
                        .unwrap_or_default(),
                    options: Vec::new(),
                    questions,
                    asked: Some(keep),
                });
                self.pump_permissions(&mut state);
            }
        }
        true
    }

    fn on_update(&self, update: &Value) {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut state = self.state.lock();
        // Said at any time, not only during a turn.
        if kind == "available_commands_update" {
            if let Some(list) = update.get("availableCommands").and_then(Value::as_array) {
                state.commands = parse_commands(list);
            }
            return;
        }
        if kind == "session_info_update" {
            let retry = update.pointer("/_meta/opencode~1retry");
            if let Some(retry) = retry {
                let rate_limit = retry.pointer("/error/type").and_then(Value::as_str)
                    == Some("provider.rate-limit");
                let resets_at = retry
                    .get("nextRetryAt")
                    .and_then(Value::as_str)
                    .and_then(|value| {
                        time::OffsetDateTime::parse(
                            value,
                            &time::format_description::well_known::Rfc3339,
                        )
                        .ok()
                    })
                    .map(|value| value.unix_timestamp());
                if let (true, Some(turn_id), Some(resets_at)) = (rate_limit, state.turn, resets_at)
                {
                    let now = time::OffsetDateTime::now_utc().unix_timestamp();
                    if resets_at >= now {
                        state.rate_attempts = state.rate_attempts.saturating_add(1);
                        let delay = (60_i64
                            * (1_i64 << state.rate_attempts.saturating_sub(1).min(4)))
                        .min(900);
                        let resets_at = resets_at.max(now + delay);
                        (self.emit)(BackendEvent::RateLimited { turn_id, resets_at });
                        if let (Some(client), Some(id)) =
                            (self.client.get(), self.acp_session_id.get())
                        {
                            let _ = client.notify("session/cancel", json!({ "sessionId": id }));
                        }
                    }
                }
            }
        }
        if kind == "usage_update" {
            if let (Some(used), Some(size)) = (
                update.get("used").and_then(Value::as_u64),
                update.get("size").and_then(Value::as_u64),
            ) {
                if size > 0 {
                    (self.emit)(BackendEvent::ContextUsage { used, size });
                }
            }
            return;
        }
        let Some(turn_id) = state.turn else {
            return;
        };
        match kind {
            "agent_thought_chunk" => {
                if let Some(text) = update
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    (self.emit)(BackendEvent::Reasoning {
                        turn_id,
                        text: text.to_string(),
                    });
                }
            }
            "agent_message_chunk" => {
                let text = update
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !text.is_empty() {
                    (self.emit)(BackendEvent::Delta {
                        turn_id,
                        text: text.to_string(),
                    });
                }
            }
            "tool_call" | "tool_call_update" => {
                self.on_tool(&mut state, turn_id, update);
            }
            _ => {}
        }
    }

    /// The child session a `session/update` is addressed to, if it names one already seen.
    fn known_child(&self, params: &Value) -> Option<ChildSession> {
        let id = params.get("sessionId").and_then(Value::as_str)?;
        let title = self.state.lock().children.get(id)?.clone();
        Some(ChildSession {
            id: id.to_string(),
            title,
        })
    }

    fn on_child_update(&self, child: &ChildSession, update: &Value) {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut state = self.state.lock();
        state.children.insert(child.id.clone(), child.title.clone());
        let emit = |update: SubagentUpdate| {
            (self.emit)(BackendEvent::Subagent {
                id: child.id.clone(),
                title: child.title.clone(),
                update,
            });
        };
        match kind {
            "agent_thought_chunk" => {
                if let Some(text) = update
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    emit(SubagentUpdate::Reasoning {
                        text: text.to_string(),
                    });
                }
            }
            "agent_message_chunk" => {
                let text = update
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !text.is_empty() {
                    emit(SubagentUpdate::Delta {
                        text: text.to_string(),
                    });
                }
            }
            "tool_call" | "tool_call_update" => {
                let Some(acp_id) = update.get("toolCallId").and_then(Value::as_str) else {
                    return;
                };
                let call_id = match state.child_calls.get(acp_id) {
                    Some(call_id) => *call_id,
                    None => {
                        let call_id = ToolCallId::new();
                        state.child_calls.insert(acp_id.to_string(), call_id);
                        emit(SubagentUpdate::Tool {
                            call_id,
                            name: update
                                .get("title")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string(),
                            input: raw_input_text(update.get("rawInput")).unwrap_or_default(),
                        });
                        call_id
                    }
                };
                let status = update.get("status").and_then(Value::as_str);
                if matches!(status, Some("completed" | "failed")) {
                    emit(SubagentUpdate::ToolResult {
                        call_id,
                        output: tool_output(update),
                        ok: status == Some("completed"),
                    });
                }
            }
            _ => {}
        }
    }

    /// Announces a tool call the first time it is seen, then streams refinements.
    fn on_tool(&self, state: &mut AcpState, turn_id: TurnId, update: &Value) {
        let Some(acp_id) = update.get("toolCallId").and_then(Value::as_str) else {
            return;
        };
        let title = update.get("title").and_then(Value::as_str);
        let input = raw_input_text(update.get("rawInput"));

        let call_id = match state.tools.get_mut(acp_id) {
            Some(meta) => {
                let name = title
                    .filter(|title| *title != meta.name)
                    .map(str::to_string);
                let new_input = input.clone().filter(|input| *input != meta.input);
                if name.is_some() || new_input.is_some() {
                    if let Some(name) = &name {
                        meta.name = name.clone();
                    }
                    if let Some(input) = &new_input {
                        meta.input = input.clone();
                    }
                    (self.emit)(BackendEvent::ToolUpdate {
                        turn_id,
                        call_id: meta.id,
                        name,
                        input: new_input,
                    });
                }
                meta.id
            }
            None => self.announce_tool(state, turn_id, acp_id, title, input),
        };

        let status = update.get("status").and_then(Value::as_str);
        if matches!(status, Some("completed" | "failed")) {
            (self.emit)(BackendEvent::ToolResult {
                turn_id,
                call_id,
                output: tool_output(update),
                ok: status == Some("completed"),
            });
        }
    }

    fn announce_tool(
        &self,
        state: &mut AcpState,
        turn_id: TurnId,
        acp_id: &str,
        title: Option<&str>,
        input: Option<String>,
    ) -> ToolCallId {
        let id = ToolCallId::new();
        let name = title.unwrap_or("tool").to_string();
        let input = input.unwrap_or_default();
        state.tools.insert(
            acp_id.to_string(),
            ToolMeta {
                id,
                name: name.clone(),
                input: input.clone(),
            },
        );
        (self.emit)(BackendEvent::Tool {
            turn_id,
            call_id: id,
            name,
            input,
        });
        id
    }

    fn on_permission(&self, rpc_id: Value, params: &Value) {
        let mut state = self.state.lock();
        let Some(turn_id) = state.turn else {
            // Nothing is running: refuse rather than leave the agent hanging.
            drop(state);
            self.answer(&rpc_id, json!({ "outcome": { "outcome": "cancelled" } }));
            return;
        };
        let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let acp_id = tool_call
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let title = tool_call.get("title").and_then(Value::as_str);
        let from_child = child_session(&tool_call).is_some();
        if !from_child && !acp_id.is_empty() && !state.tools.contains_key(&acp_id) {
            let input = raw_input_text(tool_call.get("rawInput"));
            self.announce_tool(&mut state, turn_id, &acp_id, title, input);
        }
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        Some(AcpOption {
                            id: item.get("optionId")?.as_str()?.to_string(),
                            kind: item.get("kind")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let kind = tool_call
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("tool");
        state.queue.push_back(QueuedPermission {
            request_id: PermissionRequestId::new(),
            turn_id,
            rpc_id,
            tool_name: title.unwrap_or(kind).to_string(),
            detail: permission_detail(kind, &tool_call),
            options,
            questions: Vec::new(),
            asked: None,
        });
        self.pump_permissions(&mut state);
    }

    /// Surfaces the next queued permission once the previous one is answered.
    fn pump_permissions(&self, state: &mut AcpState) {
        if state.active.is_some() {
            return;
        }
        if let Some(next) = state.queue.pop_front() {
            (self.emit)(BackendEvent::Permission {
                turn_id: next.turn_id,
                request_id: next.request_id,
                tool_name: next.tool_name.clone(),
                detail: next.detail.clone(),
                questions: next.questions.clone(),
            });
            state.active = Some(next);
        }
    }

    fn answer(&self, rpc_id: &Value, result: Value) {
        if let Some(client) = self.client.get() {
            let _ = client.respond(rpc_id, result);
        }
    }

    /// Prompts a child session directly and reports how it ended.
    fn run_child_prompt(&self, child: &str, text: &str) {
        let title = self
            .state
            .lock()
            .children
            .get(child)
            .cloned()
            .unwrap_or_else(|| "Subagent".to_string());
        let emit = |update: SubagentUpdate, title: &str| {
            (self.emit)(BackendEvent::Subagent {
                id: child.to_string(),
                title: title.to_string(),
                update,
            });
        };
        emit(SubagentUpdate::Started, &title);
        let Some(client) = self.client.get() else {
            return;
        };
        let outcome = client.request(
            "session/prompt",
            json!({
                "sessionId": child,
                "prompt": [{ "type": "text", "text": text }]
            }),
            None,
        );
        match outcome {
            Ok(result) => {
                let reason = result
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn");
                emit(
                    SubagentUpdate::Done {
                        ok: reason == "end_turn",
                    },
                    &title,
                );
            }
            Err(error) => {
                emit(
                    SubagentUpdate::Delta {
                        text: format!("\n\n(could not reach this subagent: {})", error.message),
                    },
                    &title,
                );
                emit(SubagentUpdate::Done { ok: false }, &title);
            }
        }
    }

    fn run_prompt(&self, turn_id: TurnId, text: String) {
        if let Err(message) = self.wait_open() {
            self.state.lock().turn = None;
            (self.emit)(BackendEvent::Error { message });
            return;
        }
        // Stopped while the session was still opening: it never reached the agent.
        let cancelled = {
            let mut state = self.state.lock();
            let cancelled = std::mem::take(&mut state.cancel_requested);
            if cancelled {
                state.turn = None;
            }
            cancelled
        };
        if cancelled {
            (self.emit)(BackendEvent::TurnDone { turn_id, ok: false });
            return;
        }
        let Some(client) = self.client.get() else {
            return;
        };
        let Some(session_id) = self.acp_session_id.get() else {
            return;
        };
        let outcome = client.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }]
            }),
            None,
        );
        let cancelled = {
            let mut state = self.state.lock();
            state.turn = None;
            state.queue.clear();
            state.active = None;
            std::mem::take(&mut state.cancel_requested)
        };
        match outcome {
            Ok(result) => {
                let reason = result
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn");
                if reason == "end_turn" && !cancelled {
                    self.state.lock().rate_attempts = 0;
                }
                if !matches!(reason, "end_turn" | "cancelled") {
                    (self.emit)(BackendEvent::Delta {
                        turn_id,
                        text: format!("\n\n(stopped: {reason})"),
                    });
                }
                (self.emit)(BackendEvent::TurnDone {
                    turn_id,
                    ok: reason == "end_turn" && !cancelled,
                });
            }
            Err(error) => {
                (self.emit)(BackendEvent::Error {
                    message: self.with_exit_info(error.message),
                });
            }
        }
    }
}

struct AcpSession {
    shared: Arc<AcpShared>,
    /// The session of an earlier run was picked up again.
    resumed: bool,
}

impl BackendSession for AcpSession {
    fn commands(&self) -> Vec<SlashCommand> {
        self.shared.state.lock().commands.clone()
    }

    fn conversation(&self) -> Option<String> {
        self.shared.acp_session_id.get().cloned()
    }

    fn resumed(&self) -> bool {
        self.resumed
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
                self.shared
                    .with_exit_info(format!("{} is not running", self.shared.dialect.name())),
            ));
        }
        let shared = Arc::clone(&self.shared);
        let (child, text) = (subagent_id.to_string(), text.to_string());
        thread::spawn(move || shared.run_child_prompt(&child, &text));
        Ok(SubagentRoute::Direct)
    }

    fn apply_settings(
        &self,
        model: Option<&str>,
        effort: Option<&str>,
        agent: Option<&str>,
    ) -> bool {
        self.shared.wait_open().is_ok() && self.shared.apply(model, effort, agent).is_ok()
    }

    /// Cursor switches model in about a second and a half, against five or so for a new process
    /// and session.
    fn keeps_conversation_on_model_change(&self) -> bool {
        self.shared.dialect == Dialect::Cursor
    }

    fn options(&self) -> SessionOptions {
        // The agent lists them when its session opens.
        let _ = self.shared.wait_open();
        let config = self.shared.config.lock();
        let values = |category: &str, id: &str| -> Vec<ConfigValue> {
            config
                .iter()
                .find(|option| option.is(category, id))
                .map(|option| option.values.clone())
                .unwrap_or_default()
        };
        let initial = self.shared.initial.lock();
        let default_model = config
            .iter()
            .find(|option| option.is("model", "model"))
            .and_then(|option| initial.get(&option.id).cloned());
        SessionOptions {
            models: values("model", "model")
                .into_iter()
                .map(|item| ModelChoice {
                    id: item.value,
                    label: item.name,
                    efforts: Vec::new(),
                })
                .collect(),
            default_model,
            // Levels of the model in use.
            efforts: Reasoning::of(&config).choices(),
            agents: values("mode", "mode")
                .into_iter()
                .map(|item| AgentChoice {
                    id: item.value,
                    label: item.name,
                    description: item.description,
                })
                .collect(),
        }
    }

    fn prompt(&self, turn_id: TurnId, text: &str) -> Result<()> {
        if !self.is_alive() {
            return Err(Error::new(
                ErrorCode::Agent,
                self.shared
                    .with_exit_info(format!("{} is not running", self.shared.dialect.name())),
            ));
        }
        {
            let mut state = self.shared.state.lock();
            state.turn = Some(turn_id);
            state.cancel_requested = false;
        }
        let shared = Arc::clone(&self.shared);
        let text = text.to_string();
        thread::spawn(move || shared.run_prompt(turn_id, text));
        Ok(())
    }

    fn cancel(&self) -> Result<()> {
        let rejected: Vec<Value> = {
            let mut state = self.shared.state.lock();
            if state.turn.is_none() {
                return Ok(());
            }
            state.cancel_requested = true;
            let mut ids: Vec<Value> = state.queue.drain(..).map(|item| item.rpc_id).collect();
            if let Some(active) = state.active.take() {
                ids.push(active.rpc_id);
            }
            ids
        };
        // ACP: outstanding permission requests must be answered `cancelled` on cancel.
        for rpc_id in rejected {
            self.shared
                .answer(&rpc_id, json!({ "outcome": { "outcome": "cancelled" } }));
        }
        if let (Some(client), Some(session_id)) =
            (self.shared.client.get(), self.shared.acp_session_id.get())
        {
            client.notify("session/cancel", json!({ "sessionId": session_id }))?;
        }
        Ok(())
    }

    fn resolve_permission(&self, decision: &PermissionDecision) -> Result<()> {
        let (rpc_id, outcome) = {
            let mut state = self.shared.state.lock();
            let matches_active = state
                .active
                .as_ref()
                .is_some_and(|active| active.request_id == decision.request_id);
            if !matches_active {
                return Err(Error::new(ErrorCode::Invalid, "no matching permission"));
            }
            let active = state.active.take().expect("checked above");
            let result = match &active.asked {
                // A question's reply already carries its `outcome`.
                Some(keep) => super::cursor::reply(keep, decision),
                None => {
                    let outcome = match pick_option(&active.options, decision.allow) {
                        Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
                        None => json!({ "outcome": "cancelled" }),
                    };
                    json!({ "outcome": outcome })
                }
            };
            (active.rpc_id, result)
        };
        self.shared.answer(&rpc_id, outcome);
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

/// Allow → `allow_once` (then `allow_always`); deny → `reject_once` (then `reject_always`).
fn pick_option(options: &[AcpOption], allow: bool) -> Option<String> {
    let order: [&str; 2] = if allow {
        ["allow_once", "allow_always"]
    } else {
        ["reject_once", "reject_always"]
    };
    order
        .iter()
        .find_map(|wanted| options.iter().find(|option| option.kind == *wanted))
        .map(|option| option.id.clone())
}

fn raw_input_text(raw: Option<&Value>) -> Option<String> {
    match raw {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) if map.is_empty() => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => serde_json::to_string_pretty(other).ok(),
    }
}

fn permission_detail(kind: &str, tool_call: &Value) -> String {
    let raw = tool_call.get("rawInput");
    let command = raw
        .and_then(|raw| raw.get("command"))
        .and_then(Value::as_str);
    let path = tool_call
        .pointer("/locations/0/path")
        .and_then(Value::as_str)
        .or_else(|| {
            raw.and_then(|raw| raw.get("filepath").or_else(|| raw.get("filePath")))
                .and_then(Value::as_str)
        });
    let title = tool_call.get("title").and_then(Value::as_str);
    let subject = command.or(path).or(title).unwrap_or("this action");
    match kind {
        "execute" => format!("Allow running: {subject}"),
        "edit" => format!("Allow editing: {subject}"),
        "read" => format!("Allow reading: {subject}"),
        "delete" => format!("Allow deleting: {subject}"),
        _ => format!("Allow {kind}: {subject}"),
    }
}

fn tool_output(update: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(items) = update.get("content").and_then(Value::as_array) {
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("content") => {
                    if let Some(text) = item.pointer("/content/text").and_then(Value::as_str) {
                        parts.push(text.to_string());
                    }
                }
                Some("diff") => {
                    if let Some(path) = item.get("path").and_then(Value::as_str) {
                        parts.push(format!("Edited {path}"));
                    }
                }
                _ => {}
            }
        }
    }
    if parts.is_empty() {
        match update.get("rawOutput") {
            Some(Value::String(text)) => parts.push(text.clone()),
            Some(Value::Null) | None => {}
            Some(raw) => {
                let text = raw
                    .get("output")
                    .or_else(|| raw.get("error"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| serde_json::to_string_pretty(raw).ok());
                parts.extend(text);
            }
        }
    }
    truncate_output(parts.join("\n"))
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{self, Receiver};
    use std::time::Instant;

    use super::*;

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
    fn opencode_skill_permissions_deny_native_skills_and_allow_only_ataraxia_skills() {
        let skills = vec![super::super::config::SkillDefinition {
            id: "selected-skill".into(),
            name: "selected-skill".into(),
            description: "Selected by Ataraxia".into(),
            path: PathBuf::from("/ataraxia/skills/selected-skill/SKILL.md"),
        }];

        let permissions = opencode_skill_permissions(&skills);

        assert_eq!(permissions.len(), 2);
        assert_eq!(permissions[0]["action"], "skill");
        assert_eq!(permissions[0]["resource"], "*");
        assert_eq!(permissions[0]["effect"], "deny");
        assert_eq!(permissions[1]["resource"], "selected-skill");
        assert_eq!(permissions[1]["effect"], "allow");
        assert_eq!(opencode_skill_permissions(&[]).len(), 1);
    }

    #[test]
    fn local_mcp_servers_with_a_cwd_use_native_config_and_keep_their_arguments() {
        let servers = json!({
            "local": {
                "command": "node",
                "args": ["server.js", "--quiet"],
                "cwd": "tools/mcp",
                "env": { "TOKEN": "secret" }
            },
            "default-cwd": { "command": "mcp-server" }
        });
        let servers = servers.as_object().expect("MCP server map");

        let native = opencode_config_mcp_servers(servers).expect("native config");
        assert_eq!(
            native["local"],
            json!({
                "type": "local",
                "command": ["node", "server.js", "--quiet"],
                "cwd": "tools/mcp",
                "environment": { "TOKEN": "secret" }
            })
        );
        assert_eq!(native.get("default-cwd"), None);

        let acp = acp_mcp_servers(Dialect::OpenCode, servers, true, true).expect("ACP config");
        assert_eq!(acp.len(), 1);
        assert_eq!(acp[0]["name"], "default-cwd");
        assert_eq!(acp[0]["args"], json!([]));
        assert_eq!(acp[0]["env"], json!([]));
    }

    #[test]
    fn remote_mcp_servers_use_native_config_so_opencode_can_sign_in_to_them() {
        let servers = json!({
            "Notion": { "url": "https://mcp.notion.com/mcp" },
            "api": { "url": "https://example.test/mcp", "headers": { "X-Key": "k" } }
        });
        let servers = servers.as_object().expect("MCP server map");

        let native = opencode_config_mcp_servers(servers).expect("native config");
        assert_eq!(
            native["Notion"],
            json!({ "type": "remote", "url": "https://mcp.notion.com/mcp" })
        );
        assert_eq!(native["api"]["headers"]["X-Key"], "k");
        // Never over ACP: an agent without the HTTP transport would refuse the whole session.
        let acp = acp_mcp_servers(Dialect::OpenCode, servers, false, false).expect("ACP config");
        assert!(acp.is_empty());
    }

    #[test]
    fn a_remote_server_over_acp_carries_its_headers_even_when_it_has_none() {
        let servers = json!({
            "Notion": { "url": "https://mcp.notion.com/mcp" },
            "api": { "url": "https://example.test/mcp", "headers": { "X-Key": "k" } },
            "stream": { "url": "https://example.test/sse", "type": "sse" }
        });
        let servers = servers.as_object().expect("MCP server map");

        // Cursor takes every server over ACP and checks each against the protocol's schema,
        // where `headers` is required: without it the whole session was refused.
        let acp = acp_mcp_servers(Dialect::Cursor, servers, true, true).expect("ACP config");
        let server = |name: &str| {
            acp.iter()
                .find(|server| server["name"] == name)
                .expect("server sent")
        };
        assert_eq!(server("Notion")["type"], "http");
        assert_eq!(server("Notion")["headers"], json!([]));
        assert_eq!(
            server("api")["headers"],
            json!([{ "name": "X-Key", "value": "k" }])
        );
        assert_eq!(server("stream")["type"], "sse");
        assert_eq!(server("stream")["headers"], json!([]));
    }

    #[test]
    #[ignore = "needs the opencode CLI and python3"]
    fn the_real_opencode_discovers_stdio_mcp_without_optional_env() {
        use super::super::config::AgentConfiguration;

        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        let report = cwd.join("mcp-probe.log");
        let session = OpenCodeBackend::new()
            .start(BackendContext {
                launch: Some(Launch {
                    env: vec![
                        (
                            "XDG_DATA_HOME".into(),
                            cwd.join("data").display().to_string(),
                        ),
                        (
                            "XDG_CACHE_HOME".into(),
                            cwd.join("cache").display().to_string(),
                        ),
                        (
                            "XDG_STATE_HOME".into(),
                            cwd.join("state").display().to_string(),
                        ),
                    ],
                    ..Launch::default()
                }),
                read_only: false,
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
                        "ataraxia-probe": {
                            "command": "python3",
                            "args": [
                                concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mcp_probe.py"),
                                report
                            ]
                        }
                    }))
                    .unwrap(),
                    ..AgentConfiguration::default()
                },
                emit: Arc::new(|_| {}),
            })
            .expect("start real OpenCode");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut discovered = false;
        while std::time::Instant::now() < deadline {
            if std::fs::read_to_string(&report).as_deref().ok() == Some("tools/list") {
                discovered = true;
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        session.shutdown();
        assert!(discovered, "OpenCode did not request tools/list");
    }

    fn mock_backend() -> OpenCodeBackend {
        OpenCodeBackend::with_command(
            PathBuf::from("python3"),
            vec![
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/fixtures/mock_acp_agent.py"
                )
                .into(),
            ],
        )
    }

    struct Harness {
        session: Arc<dyn BackendSession>,
        events: Receiver<BackendEvent>,
    }

    fn start() -> Harness {
        start_with(None, None, None)
    }

    fn start_with(model: Option<&str>, effort: Option<&str>, agent: Option<&str>) -> Harness {
        start_full(model, effort, agent, None)
    }

    fn start_full(
        model: Option<&str>,
        effort: Option<&str>,
        agent: Option<&str>,
        resume: Option<&str>,
    ) -> Harness {
        let (sender, events) = mpsc::channel();
        let sender = Mutex::new(sender);
        let session = mock_backend()
            .start(BackendContext {
                launch: None,
                read_only: false,
                session_id: crate::domain::ids::SessionId::new(),
                cwd: std::env::temp_dir(),
                extra_dirs: Vec::new(),
                model: model.map(str::to_string),
                effort: effort.map(str::to_string),
                agent: agent.map(str::to_string),
                resume: resume.map(str::to_string),
                api: None,
                config: super::super::config::AgentConfiguration::default(),
                emit: Arc::new(move |event| {
                    let _ = sender.lock().send(event);
                }),
            })
            .expect("handshake with mock agent");
        Harness { session, events }
    }

    #[test]
    fn the_commands_the_agent_announces_are_offered_with_their_hint() {
        let h = start();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut commands = h.session.commands();
        while commands.is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
            commands = h.session.commands();
        }
        h.session.shutdown();
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].name, "review");
        assert_eq!(commands[0].hint.as_deref(), Some("commit|branch|pr"));
        assert_eq!(commands[1].name, "compact");
        assert_eq!(commands[1].hint, None);
    }

    #[test]
    fn a_session_the_agent_still_has_is_picked_up_again() {
        let h = start_full(None, None, None, Some("ses_old"));
        assert!(h.session.resumed());
        assert_eq!(h.session.conversation().as_deref(), Some("ses_old"));
        h.session.shutdown();
    }

    #[test]
    fn a_session_the_agent_lost_begins_a_new_one() {
        let h = start_full(None, None, None, Some("gone_session"));
        assert!(!h.session.resumed());
        assert_eq!(h.session.conversation().as_deref(), Some("ses_mock"));
        h.session.shutdown();
    }

    #[test]
    fn a_first_run_begins_a_session_and_reports_it() {
        let h = start();
        assert!(!h.session.resumed());
        assert_eq!(h.session.conversation().as_deref(), Some("ses_mock"));
        h.session.shutdown();
    }

    fn state_line(h: &Harness) -> String {
        h.session
            .prompt(TurnId::new(), "state please")
            .expect("prompt");
        let seen = h.until("turn done", is_turn_done);
        seen.iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn models_effort_and_agents_come_from_the_session_config() {
        let h = start();
        let options = h.session.options();
        h.session.shutdown();
        let models: Vec<_> = options.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(models, ["mock/smart", "mock/fast"]);
        assert_eq!(options.default_model.as_deref(), Some("mock/smart"));
        assert_eq!(
            options.efforts,
            ["low", "high"],
            "the default entry is not a level"
        );
        let agents: Vec<_> = options.agents.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(agents, ["build", "plan"]);
        assert_eq!(options.agents[0].description.as_deref(), Some("Builds"));
    }

    #[test]
    fn saved_settings_are_applied_when_the_session_starts() {
        let h = start_with(Some("mock/smart"), Some("high"), Some("plan"));
        assert_eq!(state_line(&h), "model=mock/smart effort=high mode=plan");
        h.session.shutdown();
    }

    #[test]
    fn settings_change_live_and_return_to_defaults() {
        let h = start();
        assert!(
            h.session
                .apply_settings(Some("mock/fast"), None, Some("plan"))
        );
        assert_eq!(state_line(&h), "model=mock/fast effort=default mode=plan");
        // This model has no effort levels, so the picker must empty out.
        assert!(h.session.options().efforts.is_empty());
        assert!(h.session.apply_settings(None, None, None));
        assert_eq!(state_line(&h), "model=mock/smart effort=default mode=build");
        h.session.shutdown();
    }

    #[test]
    fn a_message_to_a_subagent_is_answered_in_its_own_conversation() {
        let h = start();
        // The child has to be seen first, as it is in a real run.
        h.session
            .prompt(TurnId::new(), "child please")
            .expect("prompt");
        h.until("turn done", is_turn_done);
        let route = h
            .session
            .message_subagent(TurnId::new(), "ses_child", "run the tests")
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
        let reply: String = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Subagent {
                    id,
                    title,
                    update: SubagentUpdate::Delta { text },
                } => {
                    assert_eq!((id.as_str(), title.as_str()), ("ses_child", "Explore"));
                    Some(text.as_str())
                }
                _ => None,
            })
            .collect();
        assert_eq!(reply, "Child heard: run the tests");
        assert!(
            !seen
                .iter()
                .any(|event| matches!(event, BackendEvent::Delta { .. }))
        );
    }

    #[test]
    fn child_session_updates_become_a_subagent_conversation() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "child please")
            .expect("prompt");
        let seen = h.until("turn done", is_turn_done);
        h.session.shutdown();
        let child: Vec<_> = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Subagent { id, title, update } => Some((id, title, update)),
                _ => None,
            })
            .collect();
        assert!(
            child
                .iter()
                .all(|(id, title, _)| *id == "ses_child" && *title == "Explore")
        );
        assert!(child.iter().any(
            |(_, _, update)| matches!(update, SubagentUpdate::Delta { text } if text == "Scanning")
        ));
        assert!(child.iter().any(
            |(_, _, update)| matches!(update, SubagentUpdate::Tool { name, .. } if name == "grep")
        ));
        assert!(child.iter().any(|(_, _, update)| matches!(
            update,
            SubagentUpdate::ToolResult { ok: true, output, .. } if output == "3 hits"
        )));
        // The child's chatter and tool stay out of the main conversation.
        let main: String = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(main, "Delegating. Back.");
        assert!(
            !seen
                .iter()
                .any(|event| matches!(event, BackendEvent::Tool { .. }))
        );
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

    #[test]
    fn streams_a_plain_reply() {
        let h = start();
        let turn = TurnId::new();
        h.session.prompt(turn, "say hi").expect("prompt");
        let seen = h.until("turn done", is_turn_done);
        let text: String = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "Hello world");
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
        let turn = TurnId::new();
        h.session.prompt(turn, "tool please").expect("prompt");
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
                answers: Default::default(),
            })
            .expect("resolve");
        seen.extend(h.until("turn done", is_turn_done));
        h.session.shutdown();
        seen
    }

    #[test]
    fn approved_tool_call_completes() {
        let seen = run_tool_turn(true);
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Tool { name, .. } if name == "write"
        )));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::ToolUpdate { input: Some(input), .. } if input.contains("/work/a.txt")
        )));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Permission { detail, .. } if detail == "Allow editing: /work/a.txt"
        )));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::ToolResult { ok: true, output, .. } if output == "written"
        )));
        assert!(matches!(
            seen.last(),
            Some(BackendEvent::TurnDone { ok: true, .. })
        ));
    }

    #[test]
    fn denied_tool_call_fails() {
        let seen = run_tool_turn(false);
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::ToolResult { ok: false, output, .. } if output.contains("rejected")
        )));
    }

    #[test]
    fn cancel_ends_the_turn_unsuccessfully() {
        let h = start();
        let turn = TurnId::new();
        h.session.prompt(turn, "hang").expect("prompt");
        h.until("first chunk", |event| {
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
    fn process_exit_reports_stderr_and_marks_session_dead() {
        let h = start();
        h.session.prompt(TurnId::new(), "crash").expect("prompt");
        let seen = h.until("error", |event| matches!(event, BackendEvent::Error { .. }));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Error { message } if message.contains("boom")
        )));
        let deadline = Instant::now() + Duration::from_secs(5);
        while h.session.is_alive() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!h.session.is_alive());
        assert!(h.session.prompt(TurnId::new(), "again").is_err());
    }

    #[test]
    fn missing_binary_is_unavailable() {
        let backend = OpenCodeBackend::with_command(PathBuf::from("/definitely/not/here"), vec![]);
        assert!(backend.availability().is_ok());
        let error = backend
            .start(BackendContext {
                launch: None,
                read_only: false,
                session_id: crate::domain::ids::SessionId::new(),
                cwd: std::env::temp_dir(),
                extra_dirs: Vec::new(),
                model: None,
                effort: None,
                agent: None,
                resume: None,
                api: None,
                config: super::super::config::AgentConfiguration::default(),
                emit: Arc::new(|_| {}),
            })
            .err()
            .expect("spawn failure");
        assert_eq!(error.code, ErrorCode::Agent);
    }

    #[test]
    fn option_picking_prefers_once_variants() {
        let options = vec![
            AcpOption {
                id: "always".into(),
                kind: "allow_always".into(),
            },
            AcpOption {
                id: "once".into(),
                kind: "allow_once".into(),
            },
            AcpOption {
                id: "no".into(),
                kind: "reject_once".into(),
            },
        ];
        assert_eq!(pick_option(&options, true).as_deref(), Some("once"));
        assert_eq!(pick_option(&options, false).as_deref(), Some("no"));
        assert_eq!(pick_option(&options[..1], false), None);
    }
}
