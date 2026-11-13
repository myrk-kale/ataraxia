//! Provider-facing seam used by [`super::host::AgentHost`].
//!
//! A backend owns the process/protocol for one provider session and reports
//! what happened as [`BackendEvent`]s. The host turns those into transcript
//! state, session status and outbound [`crate::domain::AgentEvent`]s.

use std::path::PathBuf;
use std::sync::Arc;

use crate::domain::agent::SessionOptions;
use crate::domain::ids::{SessionId, TurnId};
use crate::domain::{PermissionDecision, PermissionRequestId, Result, SubagentUpdate, ToolCallId};
use crate::ports::ApiAccess;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendEvent {
    Delta {
        turn_id: TurnId,
        text: String,
    },
    Tool {
        turn_id: TurnId,
        call_id: ToolCallId,
        name: String,
        input: String,
    },
    /// Refines a tool call announced earlier (providers often stream the input afterwards).
    ToolUpdate {
        turn_id: TurnId,
        call_id: ToolCallId,
        name: Option<String>,
        input: Option<String>,
    },
    ToolResult {
        turn_id: TurnId,
        call_id: ToolCallId,
        output: String,
        ok: bool,
    },
    Permission {
        turn_id: TurnId,
        request_id: PermissionRequestId,
        tool_name: String,
        detail: String,
    },
    TurnDone {
        turn_id: TurnId,
        ok: bool,
    },
    /// The agent started a turn nobody asked for (for example the report of a background
    /// subagent). Its events and its `TurnDone` use this id.
    TurnStarted {
        turn_id: TurnId,
    },
    /// Progress inside a subagent's own conversation.
    Subagent {
        id: String,
        title: String,
        update: SubagentUpdate,
    },
    Error {
        message: String,
    },
}

/// How a message to a subagent is carried out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentRoute {
    /// Sent straight to the subagent; the main conversation stays idle.
    Direct,
    /// Relayed by the main agent, so the main conversation runs a turn meanwhile.
    MainTurn,
}

pub type Emitter = Arc<dyn Fn(BackendEvent) + Send + Sync>;

pub struct BackendContext {
    pub session_id: SessionId,
    pub cwd: PathBuf,
    /// Other repositories of the chat's workspace the agent may read and edit, besides `cwd`.
    pub extra_dirs: Vec<PathBuf>,
    /// Model override chosen for this chat (`None` = provider default).
    pub model: Option<String>,
    /// Reasoning-effort override (`None` = provider default).
    pub effort: Option<String>,
    /// Named agent to run as (`None` = the provider's default agent).
    pub agent: Option<String>,
    /// The session only investigates: provider-side sandboxing keeps it from writing.
    pub read_only: bool,
    /// Where the agent finds Ataraxia's local API, with a token for this process only.
    pub api: Option<ApiAccess>,
    pub emit: Emitter,
}

pub const API_URL_ENV: &str = "ATARAXIA_API_URL";
pub const API_TOKEN_ENV: &str = "ATARAXIA_API_TOKEN";
pub const API_SESSION_ENV: &str = "ATARAXIA_SESSION_ID";

/// The variables that point an agent process at the local API; empty without API access.
pub fn api_env(session_id: SessionId, api: Option<&ApiAccess>) -> Vec<(String, String)> {
    match api {
        Some(access) => vec![
            (API_URL_ENV.into(), access.url.clone()),
            (API_TOKEN_ENV.into(), access.token.clone()),
            (API_SESSION_ENV.into(), session_id.0.to_string()),
        ],
        None => Vec::new(),
    }
}

pub trait AgentBackend: Send + Sync {
    /// `Err(reason)` when the provider cannot run on this machine (CLI missing, ...).
    fn availability(&self) -> std::result::Result<(), String> {
        Ok(())
    }

    fn start(&self, ctx: BackendContext) -> Result<Arc<dyn BackendSession>>;
}

/// A live provider session. Methods take `&self`; implementations use interior mutability.
pub trait BackendSession: Send + Sync {
    fn prompt(&self, turn_id: TurnId, text: &str) -> Result<()>;
    /// Must lead to exactly one `TurnDone { ok: false }` for the active turn.
    fn cancel(&self) -> Result<()>;
    fn resolve_permission(&self, decision: &PermissionDecision) -> Result<()>;
    /// False once the underlying process is gone; the host then restarts the session on demand.
    fn is_alive(&self) -> bool {
        true
    }
    /// Applies a new model/effort to the running session. Returns `false` when the provider can
    /// only pick them up on a fresh process, in which case the host restarts the session.
    fn apply_settings(
        &self,
        _model: Option<&str>,
        _effort: Option<&str>,
        _agent: Option<&str>,
    ) -> bool {
        false
    }
    /// Sends a message to a subagent. Its answer arrives as `Subagent` events; for
    /// `SubagentRoute::MainTurn` the main agent also runs `turn_id` and ends it with `TurnDone`.
    fn message_subagent(
        &self,
        _turn_id: TurnId,
        _subagent_id: &str,
        _text: &str,
    ) -> Result<SubagentRoute> {
        Err(crate::domain::Error::new(
            crate::domain::ErrorCode::Unsupported,
            "this provider cannot message a subagent",
        ))
    }
    /// Models, effort levels and agents this session offers; empty when unknown.
    fn options(&self) -> SessionOptions {
        SessionOptions::default()
    }
    fn shutdown(&self);
}

const MAX_OUTPUT_CHARS: usize = 20_000;

/// Caps tool output so one huge result cannot bloat the transcript or the event channel.
pub fn truncate_output(mut text: String) -> String {
    if text.chars().count() > MAX_OUTPUT_CHARS {
        text = text.chars().take(MAX_OUTPUT_CHARS).collect();
        text.push_str("\n… (truncated)");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_api_variables_name_the_address_the_token_and_the_session() {
        let session = SessionId::new();
        let access = ApiAccess {
            url: "http://127.0.0.1:4000".into(),
            token: "tok".into(),
        };
        let env = api_env(session, Some(&access));
        assert_eq!(
            env,
            vec![
                (
                    "ATARAXIA_API_URL".to_string(),
                    "http://127.0.0.1:4000".to_string()
                ),
                ("ATARAXIA_API_TOKEN".to_string(), "tok".to_string()),
                ("ATARAXIA_SESSION_ID".to_string(), session.0.to_string()),
            ]
        );
        assert!(api_env(session, None).is_empty());
        assert!(!format!("{access:?}").contains("\"tok\""));
    }

    #[cfg(unix)]
    #[test]
    fn a_spawned_process_sees_the_api_variables() {
        use std::sync::mpsc;
        use std::time::Duration;

        use super::super::process::{ManagedProcess, SpawnSpec};

        let session = SessionId::new();
        let access = ApiAccess {
            url: "http://127.0.0.1:4000".into(),
            token: "secret-token".into(),
        };
        let (lines, received) = mpsc::channel();
        let _process = ManagedProcess::spawn(
            &SpawnSpec {
                program: "sh".into(),
                args: vec![
                    "-c".into(),
                    "echo \"$ATARAXIA_API_URL $ATARAXIA_API_TOKEN $ATARAXIA_SESSION_ID\"".into(),
                ],
                cwd: std::env::temp_dir(),
                env: api_env(session, Some(&access)),
                env_remove: Vec::new(),
            },
            move |line| {
                let _ = lines.send(line);
            },
            |_| {},
        )
        .expect("spawn sh");
        let line = received
            .recv_timeout(Duration::from_secs(10))
            .expect("the process printed its environment");
        assert_eq!(
            line,
            format!("http://127.0.0.1:4000 secret-token {}", session.0)
        );
    }
}
