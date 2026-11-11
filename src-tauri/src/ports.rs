//! Side-effect ports. Application depends on these traits; adapters implement them.

use crate::domain::Result;
use crate::domain::agent::{CapabilityMatrix, ProviderDescriptor, ProviderKind};
use crate::domain::ids::{SessionId, TurnId};

/// Uniform agent surface for Claude / Codex / OpenCode / fakes.
pub trait AgentRuntime: Send + Sync {
    fn providers(&self) -> Vec<ProviderDescriptor>;
    fn capabilities(&self, provider: ProviderKind) -> Result<CapabilityMatrix>;
}

/// Placeholder git port; concrete methods arrive with workspace persistence.
pub trait Git: Send + Sync {
    fn is_repository(&self, path: &std::path::Path) -> Result<bool>;
}

/// Placeholder filesystem port.
pub trait Fs: Send + Sync {
    fn exists(&self, path: &std::path::Path) -> Result<bool>;
}

/// Placeholder persistence port.
pub trait Store: Send + Sync {
    fn health_check(&self) -> Result<()>;
}

/// Placeholder PTY port.
pub trait PtyHost: Send + Sync {
    fn supported(&self) -> bool;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartSession {
    pub provider: ProviderKind,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedTurn {
    pub turn_id: TurnId,
}
