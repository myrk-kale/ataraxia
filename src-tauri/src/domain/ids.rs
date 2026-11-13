use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RepositoryId(pub Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WorktreeId(pub Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WorkspaceId(pub Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CheckpointId(pub Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TurnId(pub Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PtySessionId(pub Uuid);

impl RepositoryId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl WorktreeId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl WorkspaceId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl SessionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl CheckpointId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl TurnId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl PtySessionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for RepositoryId {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for WorkspaceId {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for WorktreeId {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for CheckpointId {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for TurnId {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for PtySessionId {
    fn default() -> Self {
        Self::new()
    }
}
