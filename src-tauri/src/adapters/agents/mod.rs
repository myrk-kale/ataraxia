//! Agent provider adapters (host, backends, registry).

pub mod backend;
pub mod fake;
pub mod host;
pub mod opencode;
pub mod process;
pub mod registry;
pub mod rpc;

pub use fake::FakeBackend;
pub use host::AgentHost;
pub use opencode::OpenCodeBackend;
pub use registry::ProviderRegistry;
