//! Application use-cases. Depend on domain + ports only.

pub mod actions;
pub mod analysis;
pub mod artifacts;
pub mod btw;
pub mod decisions;
pub mod engine;
pub mod fakes;
pub mod flow;
pub mod health;
pub mod heuristics;
pub mod review;
pub mod units;
pub mod workspace;

pub use engine::Engine;
pub use health::core_status_message;
pub use workspace::{WorkspaceService, WorkspaceSnapshot};

#[cfg(test)]
mod engine_tests;
