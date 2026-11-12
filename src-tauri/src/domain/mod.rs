//! Pure domain types. No I/O.

pub mod agent;
pub mod error;
pub mod ids;
pub mod repo;
pub mod session;

pub use error::{Error, ErrorCode, Result};
