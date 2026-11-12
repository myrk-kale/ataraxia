//! Application use-cases. Depend on domain + ports only.

pub mod fakes;
pub mod health;
pub mod workspace;

pub use health::core_status_message;
pub use workspace::{WorkspaceService, WorkspaceSnapshot};
