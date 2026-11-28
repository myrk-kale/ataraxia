//! The workbench: a board the agents of one workspace share. They post what they decided, what
//! they are about to change, what they ask and what they finished; the developer watches it and
//! posts to it too. Nothing here does I/O.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::error::{Error, ErrorCode, Result};
use super::ids::{SessionId, WorkspaceId};
use super::time::is_past;

/// What an entry's text may hold. Short on purpose: every agent reads the board.
pub const MAX_TEXT: usize = 600;
pub const MAX_WHY: usize = 400;
pub const MAX_TOPIC: usize = 80;
pub const MAX_PATHS: usize = 8;
pub const MAX_PATH: usize = 300;
/// How long a claim holds unless it is renewed, and the longest an agent may ask for.
pub const CLAIM_MINUTES: i64 = 45;
pub const CLAIM_MAX_MINUTES: i64 = 240;
/// A question nobody answered in this many minutes is the asker's to settle.
pub const QUESTION_PATIENCE_MINUTES: i64 = 5;
/// The most posts one agent may make in a minute: a loop is stopped, not recorded.
pub const POSTS_PER_MINUTE: usize = 12;

/// `to` of an entry meant for the developer.
pub const TO_DEVELOPER: &str = "developer";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntryKind {
    /// "I chose X for this topic."
    Decision,
    /// "I am about to create or change this": a soft lock that lapses.
    Claim,
    Question,
    /// "My part is finished, and here is where it is."
    Done,
    /// A heads-up, or an answer when it replies to something.
    Note,
    /// The developer's word: it wins over what the agents decided.
    Directive,
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Decision => "decision",
            Self::Claim => "claim",
            Self::Question => "question",
            Self::Done => "done",
            Self::Note => "note",
            Self::Directive => "directive",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "decision" => Some(Self::Decision),
            "claim" => Some(Self::Claim),
            "question" => Some(Self::Question),
            "done" => Some(Self::Done),
            "note" => Some(Self::Note),
            "directive" => Some(Self::Directive),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntryState {
    /// In force: the standing decision, a claim that holds, an open question.
    Active,
    /// Replaced by a newer decision.
    Superseded,
    /// A decision that disagrees with the standing one. It binds nobody until the developer
    /// settles it.
    Contested,
    /// A claim or directive that was given up.
    Released,
    Answered,
    /// The developer set it aside.
    Dismissed,
}

impl EntryState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Superseded => "superseded",
            Self::Contested => "contested",
            Self::Released => "released",
            Self::Answered => "answered",
            Self::Dismissed => "dismissed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "superseded" => Some(Self::Superseded),
            "contested" => Some(Self::Contested),
            "released" => Some(Self::Released),
            "answered" => Some(Self::Answered),
            "dismissed" => Some(Self::Dismissed),
            _ => None,
        }
    }
}

/// A place in the code an entry is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub path: String,
    /// A commit, or `branch@commit`, where the code can be read as it was written.
    #[serde(default)]
    pub rev: Option<String>,
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub end_line: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchEntry {
    pub id: String,
    /// The order entries were posted in, across the whole app.
    pub seq: i64,
    pub workspace_id: WorkspaceId,
    /// `None` is the developer.
    pub author: Option<SessionId>,
    /// What the author was called when it posted, so history reads right after a chat is renamed
    /// or deleted.
    pub author_label: String,
    pub kind: EntryKind,
    pub state: EntryState,
    /// What the entry is about, as a short key: `type:UserDTO`, `route:/users`.
    #[serde(default)]
    pub topic: Option<String>,
    pub text: String,
    #[serde(default)]
    pub why: Option<String>,
    /// Files or folders: what a claim holds, or what another entry is about.
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub anchor: Option<Anchor>,
    /// `developer`, or the id of the agent it is meant for. `None`: everyone.
    #[serde(default)]
    pub to: Option<String>,
    /// The entry this one answers.
    #[serde(default)]
    pub reply_to: Option<String>,
    /// When a claim lapses.
    #[serde(default)]
    pub expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl WorkbenchEntry {
    pub fn by_developer(&self) -> bool {
        self.author.is_none()
    }

    pub fn is_for_developer(&self) -> bool {
        self.to.as_deref() == Some(TO_DEVELOPER)
    }

    pub fn is_for(&self, session: SessionId) -> bool {
        self.to.as_deref() == Some(session.0.to_string().as_str())
    }

    pub fn written_by(&self, session: SessionId) -> bool {
        self.author == Some(session)
    }

    /// Still in force: active, and not past its time when it has one.
    pub fn is_live(&self) -> bool {
        self.state == EntryState::Active && !self.expires_at.as_deref().is_some_and(is_past)
    }

    /// The decision that stands on its topic: the developer's directive or an agent's decision.
    pub fn stands(&self) -> bool {
        self.state == EntryState::Active
            && matches!(self.kind, EntryKind::Decision | EntryKind::Directive)
            && self.topic.is_some()
    }
}

/// A chat that is on the workbench.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchMember {
    pub session_id: SessionId,
    pub workspace_id: WorkspaceId,
    pub joined_at: String,
    /// Where each repository's worktree stood when the chat joined (repository id to commit):
    /// what the agent changed is measured from there.
    pub base: BTreeMap<String, String>,
    /// The newest entry its agent was handed.
    pub cursor: i64,
    pub seen_at: Option<String>,
    /// Whether its agent has been told how the board works.
    pub briefed: bool,
}

// ---------------------------------------------------------------- what is accepted

fn invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorCode::Invalid, message)
}

/// A body of text as stored: trimmed, with Windows line ends made plain, not empty, not long.
pub fn clean_text(value: &str, max: usize, what: &str) -> Result<String> {
    let text = value.replace("\r\n", "\n");
    let text = text.trim();
    if text.is_empty() {
        return Err(invalid(format!("`{what}` cannot be empty")));
    }
    if text.chars().count() > max {
        return Err(invalid(format!(
            "`{what}` has at most {max} characters: say it shorter, the other agents read it"
        )));
    }
    if looks_like_secret(text) {
        return Err(invalid(
            "that looks like a secret (a key or a token): leave it off the board",
        ));
    }
    Ok(text.to_string())
}

pub fn clean_optional(value: Option<&str>, max: usize, what: &str) -> Result<Option<String>> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(None),
        Some(value) => clean_text(value, max, what).map(Some),
    }
}

/// A topic key: one line, single spaces, not long. Empty is no topic.
pub fn clean_topic(value: &str) -> Result<Option<String>> {
    let topic = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if topic.is_empty() {
        return Ok(None);
    }
    if topic.chars().count() > MAX_TOPIC {
        return Err(invalid(format!(
            "`topic` has at most {MAX_TOPIC} characters: a short key such as type:UserDTO or route:/users"
        )));
    }
    if topic.chars().any(char::is_control) {
        return Err(invalid("`topic` cannot hold control characters"));
    }
    Ok(Some(topic))
}

/// Whether two topics name the same thing: case does not tell them apart.
pub fn same_topic(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// Paths as a claim or an entry holds them: relative to the repository, no `..`, no repeats.
pub fn clean_paths(values: &[String]) -> Result<Vec<String>> {
    if values.len() > MAX_PATHS {
        return Err(invalid(format!(
            "`paths` has at most {MAX_PATHS} entries: claim a folder instead of every file"
        )));
    }
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let path = clean_path(value)?;
        if !out.contains(&path) {
            out.push(path);
        }
    }
    Ok(out)
}

pub fn clean_path(value: &str) -> Result<String> {
    let path = value.trim().replace('\\', "/");
    let path = path.trim_start_matches("./");
    let path = path.trim_end_matches('/');
    if path.is_empty() {
        return Err(invalid("a path cannot be empty"));
    }
    if path.chars().count() > MAX_PATH || path.chars().any(char::is_control) {
        return Err(invalid("a path is too long or has control characters"));
    }
    if path.starts_with('/') || path.split('/').any(|part| part == "..") {
        return Err(invalid(
            "paths are relative to the repository and cannot go up with ..",
        ));
    }
    Ok(path.to_string())
}

/// What an agent says about where its entry is: a path, and optionally a commit and lines.
pub fn clean_anchor(anchor: Anchor) -> Result<Anchor> {
    let path = clean_path(&anchor.path)?;
    let rev = anchor
        .rev
        .as_deref()
        .map(str::trim)
        .filter(|rev| !rev.is_empty())
        .map(|rev| {
            if rev.chars().count() > 120 || rev.chars().any(|c| c.is_control() || c == ' ') {
                Err(invalid("`rev` is a commit or branch@commit"))
            } else {
                Ok(rev.to_string())
            }
        })
        .transpose()?;
    let (start, end) = match (anchor.start_line, anchor.end_line) {
        (Some(start), Some(end)) if end >= start => (Some(start), Some(end)),
        (Some(start), None) => (Some(start), None),
        (None, _) => (None, None),
        (Some(_), Some(_)) => return Err(invalid("`end_line` cannot come before `start_line`")),
    };
    Ok(Anchor {
        path,
        rev,
        start_line: start,
        end_line: end,
    })
}

/// Whether a text carries something that must never be written where every agent reads it.
pub fn looks_like_secret(text: &str) -> bool {
    if text.contains("-----BEGIN") && text.contains("PRIVATE KEY") {
        return true;
    }
    const PREFIXES: [&str; 9] = [
        "ghp_",
        "gho_",
        "ghs_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "AKIA",
        "sk-ant-",
        "sk-proj-",
    ];
    text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .any(|word| word.len() >= 20 && PREFIXES.iter().any(|prefix| word.starts_with(prefix)))
}

// ---------------------------------------------------------------- how entries relate

/// Whether two claimed paths hold the same ground: the same path, or one inside the other.
pub fn paths_overlap(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim_end_matches('/'), b.trim_end_matches('/'));
    a == b
        || b.strip_prefix(a).is_some_and(|rest| rest.starts_with('/'))
        || a.strip_prefix(b).is_some_and(|rest| rest.starts_with('/'))
}

/// Lockfiles and the like: they always collide and are regenerated, never merged by hand.
pub fn is_generated(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    matches!(
        name,
        "Cargo.lock"
            | "package-lock.json"
            | "pnpm-lock.yaml"
            | "yarn.lock"
            | "bun.lockb"
            | "bun.lock"
            | "poetry.lock"
            | "Pipfile.lock"
            | "Gemfile.lock"
            | "composer.lock"
            | "go.sum"
            | "Podfile.lock"
            | "flake.lock"
    )
}

/// Whether two sets of changed line ranges (of the file as it was, both ends included) are on
/// top of each other or next to each other: git will not merge those without a person.
pub fn ranges_touch(a: &[(u32, u32)], b: &[(u32, u32)]) -> bool {
    const SLACK: u32 = 2;
    a.iter().any(|&(a_start, a_end)| {
        b.iter().any(|&(b_start, b_end)| {
            a_start <= b_end.saturating_add(SLACK) && b_start <= a_end.saturating_add(SLACK)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_states_round_trip() {
        for kind in [
            EntryKind::Decision,
            EntryKind::Claim,
            EntryKind::Question,
            EntryKind::Done,
            EntryKind::Note,
            EntryKind::Directive,
        ] {
            assert_eq!(EntryKind::parse(kind.as_str()), Some(kind));
        }
        for state in [
            EntryState::Active,
            EntryState::Superseded,
            EntryState::Contested,
            EntryState::Released,
            EntryState::Answered,
            EntryState::Dismissed,
        ] {
            assert_eq!(EntryState::parse(state.as_str()), Some(state));
        }
        assert_eq!(EntryKind::parse("chat"), None);
    }

    #[test]
    fn a_text_is_trimmed_and_cannot_be_empty_or_long() {
        assert_eq!(
            clean_text("  use zod\r\nnot yup  ", MAX_TEXT, "text").unwrap(),
            "use zod\nnot yup"
        );
        assert!(clean_text("   ", MAX_TEXT, "text").is_err());
        assert!(clean_text(&"x".repeat(MAX_TEXT + 1), MAX_TEXT, "text").is_err());
        assert_eq!(clean_optional(Some("  "), MAX_WHY, "why").unwrap(), None);
        assert_eq!(clean_optional(None, MAX_WHY, "why").unwrap(), None);
    }

    #[test]
    fn what_looks_like_a_secret_is_refused() {
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc";
        assert!(clean_text(key, MAX_TEXT, "text").is_err());
        assert!(
            clean_text(
                "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
                MAX_TEXT,
                "text"
            )
            .is_err()
        );
        assert!(clean_text("use AKIAABCDEFGHIJKLMNOP for s3", MAX_TEXT, "text").is_err());
        // Words that merely start the same way are fine.
        assert!(clean_text("the sk-learn pipeline and ghp_x", MAX_TEXT, "text").is_ok());
    }

    #[test]
    fn a_topic_is_one_line_and_compared_without_case() {
        assert_eq!(
            clean_topic("  type:UserDTO \n").unwrap().as_deref(),
            Some("type:UserDTO")
        );
        assert_eq!(clean_topic("   ").unwrap(), None);
        assert!(clean_topic(&"t".repeat(MAX_TOPIC + 1)).is_err());
        assert!(same_topic("type:UserDTO", " TYPE:userdto"));
        assert!(!same_topic("type:UserDTO", "type:User"));
    }

    #[test]
    fn paths_are_relative_clean_and_few() {
        assert_eq!(
            clean_paths(&["./src/a.rs".into(), "src/a.rs".into(), "src/b/".into()]).unwrap(),
            vec!["src/a.rs".to_string(), "src/b".to_string()]
        );
        assert!(clean_paths(&["/etc/passwd".into()]).is_err());
        assert!(clean_paths(&["../x".into()]).is_err());
        assert!(clean_paths(&["a/../b".into()]).is_err());
        assert!(clean_paths(&["".into()]).is_err());
        let many: Vec<String> = (0..=MAX_PATHS).map(|n| format!("f{n}")).collect();
        assert!(clean_paths(&many).is_err());
    }

    #[test]
    fn an_anchor_keeps_a_path_a_revision_and_ordered_lines() {
        let anchor = clean_anchor(Anchor {
            path: "./src/retry.rs".into(),
            rev: Some(" feat/a@abc123 ".into()),
            start_line: Some(4),
            end_line: Some(9),
        })
        .unwrap();
        assert_eq!(anchor.path, "src/retry.rs");
        assert_eq!(anchor.rev.as_deref(), Some("feat/a@abc123"));
        assert!(
            clean_anchor(Anchor {
                path: "a".into(),
                rev: None,
                start_line: Some(9),
                end_line: Some(4),
            })
            .is_err()
        );
        assert!(
            clean_anchor(Anchor {
                path: "a".into(),
                rev: Some("two words".into()),
                start_line: None,
                end_line: None,
            })
            .is_err()
        );
    }

    #[test]
    fn two_paths_overlap_when_they_are_the_same_or_one_holds_the_other() {
        assert!(paths_overlap("src/a.rs", "src/a.rs"));
        assert!(paths_overlap("src", "src/a.rs"));
        assert!(paths_overlap("src/a/", "src/a/b/c.rs"));
        assert!(!paths_overlap("src/a", "src/ab.rs"));
        assert!(!paths_overlap("src/a.rs", "src/b.rs"));
    }

    #[test]
    fn lockfiles_are_generated() {
        assert!(is_generated("pnpm-lock.yaml"));
        assert!(is_generated("apps/web/package-lock.json"));
        assert!(is_generated("src-tauri/Cargo.lock"));
        assert!(!is_generated("src/lock.rs"));
    }

    #[test]
    fn changed_ranges_touch_when_they_overlap_or_sit_side_by_side() {
        assert!(ranges_touch(&[(10, 20)], &[(15, 30)]));
        assert!(ranges_touch(&[(10, 20)], &[(22, 25)]));
        assert!(!ranges_touch(&[(10, 20)], &[(30, 40)]));
        assert!(!ranges_touch(&[], &[(1, 2)]));
    }

    #[test]
    fn a_claim_is_live_until_it_lapses() {
        let mut entry = WorkbenchEntry {
            id: "e".into(),
            seq: 1,
            workspace_id: WorkspaceId::new(),
            author: Some(SessionId::new()),
            author_label: "A".into(),
            kind: EntryKind::Claim,
            state: EntryState::Active,
            topic: None,
            text: "x".into(),
            why: None,
            paths: Vec::new(),
            anchor: None,
            to: None,
            reply_to: None,
            expires_at: Some("2999-01-01T00:00:00Z".into()),
            created_at: "t".into(),
            updated_at: "t".into(),
        };
        assert!(entry.is_live());
        entry.expires_at = Some("2000-01-01T00:00:00Z".into());
        assert!(!entry.is_live());
        entry.expires_at = None;
        entry.state = EntryState::Released;
        assert!(!entry.is_live());
    }
}
