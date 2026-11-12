use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Fake,
    // kebab-case would spell this "open-code"; the UI, the database and `as_str` use "opencode".
    #[serde(rename = "opencode")]
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
    /// False when the provider has no way to change model or effort from Concierge.
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

    const ALL: [ProviderKind; 4] = [
        ProviderKind::Fake,
        ProviderKind::OpenCode,
        ProviderKind::Claude,
        ProviderKind::Codex,
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
