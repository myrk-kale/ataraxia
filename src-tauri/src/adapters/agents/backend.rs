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

pub type Emitter = Arc<dyn Fn(BackendEvent) + Send + Sync>;

pub struct BackendContext {
    pub session_id: SessionId,
    pub cwd: PathBuf,
    /// Model override chosen for this chat (`None` = provider default).
    pub model: Option<String>,
    /// Reasoning-effort override (`None` = provider default).
    pub effort: Option<String>,
    /// Named agent to run as (`None` = the provider's default agent).
    pub agent: Option<String>,
    pub emit: Emitter,
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
