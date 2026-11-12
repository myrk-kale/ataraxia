//! Filesystem adapter placeholder.

use std::path::Path;

use crate::domain::Result;
use crate::ports::Fs;

#[derive(Debug, Default, Clone, Copy)]
pub struct StdFs;

impl Fs for StdFs {
    fn exists(&self, path: &Path) -> Result<bool> {
        Ok(path.exists())
    }
}
