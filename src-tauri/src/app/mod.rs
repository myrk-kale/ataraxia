//! Application use-cases. Depend on domain + ports only.

pub mod fakes;
pub mod health;

pub use health::core_status_message;
