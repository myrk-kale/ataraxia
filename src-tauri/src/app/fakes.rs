//! Recording fakes for unit tests. Concrete adapters arrive in later PRs.

use std::path::Path;
use std::sync::Mutex;

use crate::domain::agent::{CapabilityMatrix, ProviderDescriptor, ProviderKind};
use crate::domain::{Error, ErrorCode, Result};
use crate::ports::{AgentRuntime, Fs, Git, PtyHost, Store};

#[derive(Debug, Default)]
pub struct FakeGit {
    pub calls: Mutex<Vec<String>>,
}

impl Git for FakeGit {
    fn is_repository(&self, path: &Path) -> Result<bool> {
        self.calls
            .lock()
            .expect("fake git lock")
            .push(format!("is_repository:{}", path.display()));
        Ok(path.join(".git").exists())
    }
}

#[derive(Debug, Default)]
pub struct FakeFs;

impl Fs for FakeFs {
    fn exists(&self, path: &Path) -> Result<bool> {
        Ok(path.exists())
    }
}

#[derive(Debug, Default)]
pub struct FakeStore {
    pub healthy: bool,
}

impl Store for FakeStore {
    fn health_check(&self) -> Result<()> {
        if self.healthy {
            Ok(())
        } else {
            Err(Error::new(ErrorCode::Io, "store unavailable"))
        }
    }
}

#[derive(Debug, Default)]
pub struct FakePty;

impl PtyHost for FakePty {
    fn supported(&self) -> bool {
        true
    }
}

#[derive(Debug, Default)]
pub struct FakeAgentRuntime;

impl AgentRuntime for FakeAgentRuntime {
    fn providers(&self) -> Vec<ProviderDescriptor> {
        vec![ProviderDescriptor {
            kind: ProviderKind::Fake,
            display_name: "Fake".into(),
            capabilities: CapabilityMatrix::fake(),
        }]
    }

    fn capabilities(&self, provider: ProviderKind) -> Result<CapabilityMatrix> {
        match provider {
            ProviderKind::Fake => Ok(CapabilityMatrix::fake()),
            other => Err(Error::new(
                ErrorCode::Unsupported,
                format!(
                    "provider {} is not registered in the fake runtime",
                    other.as_str()
                ),
            )),
        }
    }
}
