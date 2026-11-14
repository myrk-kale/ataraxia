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
    /// Images the user attached to this message.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageAttachment>,
}

/// An image attached to a message. The picture itself is a file the app keeps, read by `id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageAttachment {
    pub id: String,
    pub name: String,
    pub mime: String,
}

/// An image as it arrives from the window, before it is checked and stored.
#[derive(Debug, Clone, Deserialize)]
pub struct ImageUpload {
    pub name: String,
    pub mime: String,
    /// The file's bytes, base64.
    pub data: String,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SubagentStatus {
    Running,
    Done,
    Failed,
}

/// A conversation a subagent had while the main agent was working (read-only in the UI).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRecord {
    pub id: String,
    pub title: String,
    pub status: SubagentStatus,
    /// Keeps running after the turn that started it ends (a background subagent).
    #[serde(default)]
    pub detached: bool,
    pub items: Vec<ChatItem>,
}

/// One step of a subagent conversation, reported by a provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SubagentUpdate {
    Started,
    /// The subagent runs in the background: it outlives the turn and reports later.
    Detached,
    /// A message the user sent to this subagent.
    #[serde(rename_all = "camelCase")]
    User {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Delta {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Tool {
        call_id: ToolCallId,
        name: String,
        input: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        call_id: ToolCallId,
        output: String,
        ok: bool,
    },
    Done {
        ok: bool,
    },
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
    /// A provider reported where its limits stand. Not about one chat: every chat on that
    /// provider shows it.
    Usage { usage: super::usage::ProviderUsage },
    #[serde(rename_all = "camelCase")]
    Delta {
        session_id: SessionId,
        turn_id: TurnId,
        role: ChatRole,
        text: String,
        /// Only on the user's own message.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageAttachment>,
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
    Subagent {
        session_id: SessionId,
        subagent_id: String,
        title: String,
        update: SubagentUpdate,
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
    /// Subagent conversations of the running agent process (not persisted across restarts).
    #[serde(default)]
    pub subagents: Vec<SubagentRecord>,
    /// Leading items that predate the running agent process (restored from disk or a restart).
    pub restored_count: usize,
    pub status: SessionStatus,
    pub pending_permission: Option<PendingPermission>,
}
