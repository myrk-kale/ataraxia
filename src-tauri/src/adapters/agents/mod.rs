//! Agent provider adapters (host, backends, registry).

pub mod backend;
pub mod fake;
pub mod host;
pub mod registry;

pub use fake::FakeBackend;
pub use host::AgentHost;
pub use registry::ProviderRegistry;
