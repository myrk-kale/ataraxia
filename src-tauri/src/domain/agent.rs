use crate::domain::ids::{SessionId, WorkspaceId};
use serde::{Deserialize, Serialize};

/// A repository-owned MCP server shown before Ataraxia lets a harness start it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepositoryMcpServer {
    pub name: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    /// Optional working directory used to launch a local MCP server.
    pub cwd: Option<String>,
    /// Names only; environment values and headers may contain secrets.
    pub environment: Vec<String>,
    pub headers: Vec<String>,
}

/// Repository MCPs that need a user's explicit trust decision before session start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepositoryMcpApproval {
    pub repository: String,
    pub fingerprint: String,
    pub servers: Vec<RepositoryMcpServer>,
}

/// A local or remote MCP server associated with a currently running agent session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProcessInfo {
    pub session_id: SessionId,
    pub workspace_id: Option<WorkspaceId>,
    pub workspace_name: Option<String>,
    pub session_title: String,
    pub provider: ProviderKind,
    pub server_name: String,
    pub status: McpProcessStatus,
    pub pid: Option<u32>,
    pub process_started_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpProcessStatus {
    Running,
    NotDetected,
    Remote,
    Unidentified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Fake,
    // kebab-case would spell this "open-code"; the UI, the database and `as_str` use "opencode".
    #[serde(rename = "opencode")]
    OpenCode,
    Claude,
    Codex,
    Cursor,
}

impl ProviderKind {
    /// Preference that remembers the model last chosen for this provider, for new chats.
    pub fn model_preference_key(self) -> String {
        format!("last_model.{}", self.as_str())
    }

    /// Preference that remembers the reasoning effort last chosen for this provider.
    pub fn effort_preference_key(self) -> String {
        format!("last_effort.{}", self.as_str())
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fake => "fake",
            Self::OpenCode => "opencode",
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "fake" => Some(Self::Fake),
            "opencode" => Some(Self::OpenCode),
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "cursor" => Some(Self::Cursor),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SteeringMode {
    None,
    Inject,
    Queue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalEnforcement {
    Provider,
    Host,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ForkMode {
    None,
    Checkpoint,
    Tip,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityMatrix {
    pub rewind: bool,
    pub fork: ForkMode,
    pub compact: bool,
    pub compact_instructions: bool,
    pub thread_goal: bool,
    pub context_usage: bool,
    pub image_prompts: bool,
    pub steering: SteeringMode,
    pub approval_enforcement: ApprovalEnforcement,
    pub child_sessions: bool,
}

impl CapabilityMatrix {
    pub fn fake() -> Self {
        Self {
            rewind: false,
            fork: ForkMode::None,
            compact: false,
            compact_instructions: false,
            thread_goal: false,
            context_usage: false,
            image_prompts: false,
            steering: SteeringMode::None,
            approval_enforcement: ApprovalEnforcement::Host,
            child_sessions: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelChoice {
    pub id: String,
    pub label: String,
    /// Effort levels this model supports; empty means "use the session-wide list".
    #[serde(default)]
    pub efforts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentChoice {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

/// An action in Ataraxia's fixed command catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    /// Optional arguments accepted by the command, such as `[instructions]`.
    pub hint: Option<String>,
    /// Where it comes from, when the harness says (user, project, a plugin).
    pub source: Option<String>,
}

/// A slash-menu resource available to a chat session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerResource {
    pub kind: ComposerResourceKind,
    pub name: String,
    pub description: String,
    pub hint: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ComposerResourceKind {
    Command,
    Skill,
    Mcp,
}

/// Commands whose names and meanings belong to Ataraxia, regardless of the active harness.
pub fn ataraxia_commands() -> Vec<SlashCommand> {
    [
        ("help", "List Ataraxia commands", None),
        ("new", "Create a new chat and keep this one", None),
        ("workspace", "Switch to the previous workspace", None),
        (
            "compact",
            "Compact this conversation",
            Some("[instructions]"),
        ),
        ("stop", "Stop the current run", None),
        ("pet", "Show or hide the pet", None),
    ]
    .into_iter()
    .map(|(name, description, hint)| SlashCommand {
        name: name.into(),
        description: description.into(),
        hint: hint.map(str::to_string),
        source: Some("Ataraxia".into()),
    })
    .collect()
}

/// A repository entry returned by the file picker. Directories are filtered before insertion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MentionPath {
    /// What goes after the `@`: relative to the folder the agent works in, or absolute for
    /// another repository of the workspace.
    pub path: String,
    /// A folder (its path ends with a slash) rather than a file.
    pub dir: bool,
    /// The repository it belongs to, when it is not the one the agent works in.
    pub repository: Option<String>,
}

/// Another conversation of the chat's workspace that `@` can point at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MentionChat {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

/// What a live session offers right now (discovered from the provider, not hard-coded).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionOptions {
    pub models: Vec<ModelChoice>,
    /// The model used when none is chosen, when the provider says so.
    pub default_model: Option<String>,
    /// Effort levels for the current model, lowest to highest.
    pub efforts: Vec<String>,
    pub agents: Vec<AgentChoice>,
}

/// What a provider lets the user tune per chat.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderSettings {
    /// False when the provider has no way to change model or effort from Ataraxia.
    pub configurable: bool,
    /// Known model presets; the provider default is always offered on top.
    pub models: Vec<ModelChoice>,
    /// Effort levels, lowest to highest. Empty when the provider has no such knob.
    pub efforts: Vec<String>,
    /// Whether any model id can be typed in.
    pub custom_model: bool,
    /// Models, efforts and agents come from the live session, so values are not checked
    /// against the lists above.
    #[serde(default)]
    pub dynamic: bool,
    /// Whether the chat can run as a named agent.
    #[serde(default)]
    pub agents: bool,
    /// Whether messages can be sent to a subagent from its own conversation.
    #[serde(default)]
    pub subagent_messages: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderDescriptor {
    pub kind: ProviderKind,
    pub display_name: String,
    pub capabilities: CapabilityMatrix,
    /// False when the provider's CLI cannot be found on this machine.
    pub available: bool,
    pub detail: Option<String>,
    pub settings: ProviderSettings,
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [ProviderKind; 5] = [
        ProviderKind::Fake,
        ProviderKind::OpenCode,
        ProviderKind::Claude,
        ProviderKind::Codex,
        ProviderKind::Cursor,
    ];

    #[test]
    fn json_names_match_the_ones_the_ui_and_database_use() {
        for kind in ALL {
            let json = serde_json::to_string(&kind).expect("serialize");
            assert_eq!(json, format!("\"{}\"", kind.as_str()));
            let back: ProviderKind = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, kind);
            assert_eq!(ProviderKind::parse(kind.as_str()), Some(kind));
        }
        // The UI sends this spelling when creating or switching an OpenCode chat.
        assert_eq!(
            serde_json::from_str::<ProviderKind>("\"opencode\"").expect("opencode"),
            ProviderKind::OpenCode
        );
    }
}
