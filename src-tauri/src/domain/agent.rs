use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Fake,
    OpenCode,
    Claude,
    Codex,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fake => "fake",
            Self::OpenCode => "opencode",
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "fake" => Some(Self::Fake),
            "opencode" => Some(Self::OpenCode),
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
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
pub struct ProviderDescriptor {
    pub kind: ProviderKind,
    pub display_name: String,
    pub capabilities: CapabilityMatrix,
    /// False when the provider's CLI cannot be found on this machine.
    pub available: bool,
    pub detail: Option<String>,
}
