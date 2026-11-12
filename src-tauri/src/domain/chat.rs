use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::ids::{SessionId, TurnId};
use crate::domain::session::SessionStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PermissionRequestId(pub Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ToolCallId(pub Uuid);

impl PermissionRequestId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for PermissionRequestId {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolCallId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for ToolCallId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatRole {
    User,
    Assistant,
    System,
}

impl ChatRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: ChatRole,
    pub text: String,
    pub turn_id: Option<TurnId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolStatus {
    Running,
    Done,
    Failed,
}

impl ToolStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub call_id: ToolCallId,
    pub turn_id: TurnId,
    pub name: String,
    pub input: String,
    pub output: Option<String>,
    pub status: ToolStatus,
}

/// One ordered entry in a chat transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatItem {
    Message(ChatMessage),
    Tool(ToolCallRecord),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub request_id: PermissionRequestId,
    pub allow: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEvent {
    #[serde(rename_all = "camelCase")]
    Status {
        session_id: SessionId,
        status: SessionStatus,
    },
    #[serde(rename_all = "camelCase")]
    Delta {
        session_id: SessionId,
        turn_id: TurnId,
        role: ChatRole,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Tool {
        session_id: SessionId,
        turn_id: TurnId,
        call_id: ToolCallId,
        name: String,
        input: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolUpdate {
        session_id: SessionId,
        turn_id: TurnId,
        call_id: ToolCallId,
        name: Option<String>,
        input: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        session_id: SessionId,
        turn_id: TurnId,
        call_id: ToolCallId,
        output: String,
        ok: bool,
    },
    #[serde(rename_all = "camelCase")]
    Permission {
        session_id: SessionId,
        turn_id: TurnId,
        request_id: PermissionRequestId,
        tool_name: String,
        detail: String,
    },
    #[serde(rename_all = "camelCase")]
    TurnDone {
        session_id: SessionId,
        turn_id: TurnId,
        ok: bool,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        session_id: SessionId,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermission {
    pub request_id: PermissionRequestId,
    pub turn_id: TurnId,
    pub tool_name: String,
    pub detail: String,
}

/// Everything the UI needs to rebuild a chat view after (re)opening a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSnapshot {
    pub items: Vec<ChatItem>,
    /// Leading items that predate the running agent process (restored from disk or a restart).
    pub restored_count: usize,
    pub status: SessionStatus,
    pub pending_permission: Option<PendingPermission>,
}
