//! Agent provider adapters (host, backends, registry).

pub mod attachments;
pub mod backend;
pub mod claude;
pub mod codex;
pub mod codex_commands;
pub mod config;
pub mod definitions;
pub mod fake;
pub mod guide;
pub mod handoff;
pub mod host;
mod mcp_oauth;
pub mod opencode;
pub mod process;
pub mod process_tree;
pub mod registry;
pub mod resources;
pub mod rpc;
pub mod subagent_tail;

pub use claude::ClaudeBackend;
pub use codex::CodexBackend;
pub use fake::FakeBackend;
pub use host::AgentHost;
pub use opencode::OpenCodeBackend;
pub use registry::ProviderRegistry;
