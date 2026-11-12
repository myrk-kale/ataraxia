//! Git CLI adapter placeholder.

use std::path::Path;
use std::process::Command;

use crate::domain::{Error, ErrorCode, Result};
use crate::ports::Git;

#[derive(Debug, Default, Clone, Copy)]
pub struct GitCli;

impl Git for GitCli {
    fn is_repository(&self, path: &Path) -> Result<bool> {
        let output = Command::new("git")
            .args(["rev-parse", "--is-inside-work-tree"])
            .current_dir(path)
            .output()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        Ok(output.status.success())
    }
}
