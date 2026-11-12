use crate::domain::agent::{
    ApprovalEnforcement, CapabilityMatrix, ForkMode, ProviderDescriptor, ProviderKind, SteeringMode,
};
use crate::domain::{Error, ErrorCode, Result};

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
                available: true,
                detail: None,
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
                available: true,
                detail: None,
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
                available: true,
                detail: None,
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
                available: true,
                detail: None,
            },
        ]
    }
}

impl ProviderRegistry {
    pub fn capabilities_for(provider: ProviderKind) -> Result<CapabilityMatrix> {
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
        assert_eq!(ProviderRegistry::descriptors().len(), 4);
        assert!(ProviderRegistry::capabilities_for(ProviderKind::OpenCode).is_ok());
    }
}
