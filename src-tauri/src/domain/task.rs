//! The developer's own to-do list. Each task has a number that never changes and is never reused,
//! so it can be named in a chat ("do #12") and the agent can fetch it through the local API.

use serde::{Deserialize, Serialize};

use super::error::{Error, ErrorCode, Result};

/// How far a task is. `Draft` is a title jotted down; `Ready` says it is clear enough to be developed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskStatus {
    #[default]
    Draft,
    Ready,
    Done,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Ready => "ready",
            Self::Done => "done",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "draft" => Some(Self::Draft),
            "ready" => Some(Self::Ready),
            "done" => Some(Self::Done),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    /// The number the developer says in a chat. Unique, and never reused.
    pub number: i64,
    pub title: String,
    /// Anything more than the title: what is wanted, where to look, what done means.
    #[serde(default)]
    pub notes: String,
    pub status: TaskStatus,
    pub created_at: String,
    pub updated_at: String,
}

pub const MAX_TITLE: usize = 200;
pub const MAX_NOTES: usize = 20_000;

/// A title as stored: trimmed, one line, not empty and not absurdly long.
pub fn clean_title(title: &str) -> Result<String> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err(Error::new(ErrorCode::Invalid, "a task needs a title"));
    }
    if title.chars().count() > MAX_TITLE {
        return Err(Error::new(
            ErrorCode::Invalid,
            format!("a task title has at most {MAX_TITLE} characters"),
        ));
    }
    Ok(title)
}

pub fn clean_notes(notes: &str) -> Result<String> {
    if notes.chars().count() > MAX_NOTES {
        return Err(Error::new(
            ErrorCode::Invalid,
            format!("task notes have at most {MAX_NOTES} characters"),
        ));
    }
    Ok(notes.trim_end().to_string())
}

/// What a caller changes in a task; what is `None` stays as it is.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub notes: Option<String>,
    pub status: Option<TaskStatus>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_is_one_trimmed_line_and_cannot_be_empty() {
        assert_eq!(
            clean_title("  fix   the\n scroll ").unwrap(),
            "fix the scroll"
        );
        assert!(clean_title("   ").is_err());
        assert!(clean_title(&"x".repeat(MAX_TITLE + 1)).is_err());
    }

    #[test]
    fn statuses_round_trip() {
        for status in [TaskStatus::Draft, TaskStatus::Ready, TaskStatus::Done] {
            assert_eq!(TaskStatus::parse(status.as_str()), Some(status));
        }
        assert_eq!(TaskStatus::parse("later"), None);
    }
}
