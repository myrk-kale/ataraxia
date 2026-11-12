use serde::{Deserialize, Serialize};
use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    Io,
    NotFound,
    Invalid,
    NotARepo,
    Unsupported,
    Agent,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Io => "io",
            Self::NotFound => "not-found",
            Self::Invalid => "invalid",
            Self::NotARepo => "not-a-repo",
            Self::Unsupported => "unsupported",
            Self::Agent => "agent",
        }
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("error[{code}]: {message}", code = self.code.as_str())]
pub struct Error {
    pub code: ErrorCode,
    pub message: String,
}

impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
