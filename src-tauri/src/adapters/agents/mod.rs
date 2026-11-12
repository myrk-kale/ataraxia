//! Agent provider adapters (host, backends, registry).

pub mod backend;
pub mod claude;
pub mod codex;
pub mod definitions;
pub mod fake;
pub mod host;
pub mod opencode;
pub mod process;
pub mod registry;
pub mod rpc;

pub use claude::ClaudeBackend;
pub use codex::CodexBackend;
pub use fake::FakeBackend;
pub use host::AgentHost;
pub use opencode::OpenCodeBackend;
pub use registry::ProviderRegistry;
