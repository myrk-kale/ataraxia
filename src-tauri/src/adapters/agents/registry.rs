use crate::domain::agent::{
    ApprovalEnforcement, CapabilityMatrix, ForkMode, ProviderDescriptor, ProviderKind, SteeringMode,
};
use crate::domain::{Error, ErrorCode, Result};
use crate::ports::AgentRuntime;

/// Declares known providers and their MVP capability matrices.
#[derive(Debug, Default)]
pub struct ProviderRegistry;

impl ProviderRegistry {
    pub fn descriptors() -> Vec<ProviderDescriptor> {
        vec![
            ProviderDescriptor {
                kind: ProviderKind::Fake,
                display_name: "Fake".into(),
                capabilities: CapabilityMatrix::fake(),
            },
            ProviderDescriptor {
                kind: ProviderKind::OpenCode,
                display_name: "OpenCode".into(),
                capabilities: CapabilityMatrix {
                    rewind: false,
                    fork: ForkMode::Tip,
                    compact: true,
                    compact_instructions: false,
                    thread_goal: false,
                    context_usage: true,
                    image_prompts: true,
                    steering: SteeringMode::Queue,
                    approval_enforcement: ApprovalEnforcement::Host,
                    child_sessions: true,
                },
            },
            ProviderDescriptor {
                kind: ProviderKind::Claude,
                display_name: "Claude Code".into(),
                capabilities: CapabilityMatrix {
                    rewind: true,
                    fork: ForkMode::Checkpoint,
                    compact: true,
                    compact_instructions: true,
                    thread_goal: false,
                    context_usage: true,
                    image_prompts: true,
                    steering: SteeringMode::Inject,
                    approval_enforcement: ApprovalEnforcement::Provider,
                    child_sessions: true,
                },
            },
            ProviderDescriptor {
                kind: ProviderKind::Codex,
                display_name: "Codex".into(),
                capabilities: CapabilityMatrix {
                    rewind: true,
                    fork: ForkMode::Checkpoint,
                    compact: true,
                    compact_instructions: false,
                    thread_goal: true,
                    context_usage: true,
                    image_prompts: true,
                    steering: SteeringMode::Inject,
                    approval_enforcement: ApprovalEnforcement::Provider,
                    child_sessions: true,
                },
            },
        ]
    }
}

impl AgentRuntime for ProviderRegistry {
    fn providers(&self) -> Vec<ProviderDescriptor> {
        Self::descriptors()
    }

    fn capabilities(&self, provider: ProviderKind) -> Result<CapabilityMatrix> {
        Self::descriptors()
            .into_iter()
            .find(|item| item.kind == provider)
            .map(|item| item.capabilities)
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::Unsupported,
                    format!("unknown provider {}", provider.as_str()),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lists_four_providers() {
        let runtime = ProviderRegistry;
        assert_eq!(runtime.providers().len(), 4);
        assert!(runtime.capabilities(ProviderKind::OpenCode).is_ok());
    }
}
