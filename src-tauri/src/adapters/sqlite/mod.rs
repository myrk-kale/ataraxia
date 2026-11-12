//! SQLite adapter placeholder. Schema arrives in PR2.

use crate::domain::Result;
use crate::ports::Store;

#[derive(Debug, Default, Clone, Copy)]
pub struct MemoryStore;

impl Store for MemoryStore {
    fn health_check(&self) -> Result<()> {
        Ok(())
    }
}
