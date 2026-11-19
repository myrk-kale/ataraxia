//! What the agents remember: a graph of notes that every chat and every provider shares.
//!
//! A [`Memory`] is a node and its [`MemoryKind`] says what sort of knowledge it is. A
//! [`MemoryLink`] is an edge, with a [`Relation`] that says how two memories relate. A memory
//! belongs to the developer (global) or to one workspace, and it does not point at the chat that
//! produced it, because chats get deleted and what was learned should not go with them.

use serde::{Deserialize, Serialize};

use super::error::{Error, ErrorCode, Result};
use super::ids::WorkspaceId;

/// The sort of knowledge a memory holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    /// A fact, a preference or a decision with its reason: "we chose Redis for the latency".
    Semantic,
    /// Something that happened: the error, its verified cause and the fix.
    Episodic,
    /// How to do something, or feedback on how to work: a workflow, a command order, a correction.
    Procedural,
    /// The state of work in progress. It expires, 14 days after it is written unless told otherwise.
    Working,
}

impl MemoryKind {
    pub const ALL: [Self; 4] = [
        Self::Semantic,
        Self::Episodic,
        Self::Procedural,
        Self::Working,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Semantic => "semantic",
            Self::Episodic => "episodic",
            Self::Procedural => "procedural",
            Self::Working => "working",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }
}

/// Who stood behind a memory when it was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemorySource {
    /// The developer said it, in so many words.
    User,
    /// The agent saw it for itself: it ran, read or verified it.
    Observed,
    /// The agent concluded it. The weakest of the three.
    Inferred,
}

impl MemorySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Observed => "observed",
            Self::Inferred => "inferred",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        [Self::User, Self::Observed, Self::Inferred]
            .into_iter()
            .find(|source| source.as_str() == value)
    }
}

/// Who wrote a memory down.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryAuthor {
    Agent,
    Developer,
}

impl MemoryAuthor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Developer => "developer",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "agent" => Some(Self::Agent),
            "developer" => Some(Self::Developer),
            _ => None,
        }
    }
}

/// How the source of a link relates to its target. Read it as "from <relation> to".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Relation {
    /// Loosely about the same thing. The only one without a direction.
    RelatesTo,
    /// A piece of a larger whole.
    PartOf,
    /// Needs the other to hold or to have happened.
    DependsOn,
    /// Happened because of the other.
    CausedBy,
    /// Gives evidence for, or the reason behind, the other.
    Supports,
    /// Cannot be true together with the other. A conflict somebody still has to settle.
    Contradicts,
    /// Replaces the other, which stays only as history.
    Supersedes,
    /// An instance of the other, which states the general rule.
    ExampleOf,
}

impl Relation {
    pub const ALL: [Self; 8] = [
        Self::RelatesTo,
        Self::PartOf,
        Self::DependsOn,
        Self::CausedBy,
        Self::Supports,
        Self::Contradicts,
        Self::Supersedes,
        Self::ExampleOf,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::RelatesTo => "relates_to",
            Self::PartOf => "part_of",
            Self::DependsOn => "depends_on",
            Self::CausedBy => "caused_by",
            Self::Supports => "supports",
            Self::Contradicts => "contradicts",
            Self::Supersedes => "supersedes",
            Self::ExampleOf => "example_of",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|relation| relation.as_str() == value)
    }

    /// Whether `a -> b` and `b -> a` say the same thing.
    pub fn symmetric(self) -> bool {
        matches!(self, Self::RelatesTo | Self::Contradicts)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub kind: MemoryKind,
    /// `None` is a global memory, the developer's own; otherwise it belongs to that workspace.
    pub workspace_id: Option<WorkspaceId>,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub source: MemorySource,
    pub author: MemoryAuthor,
    /// After this moment the memory is no longer offered to agents.
    pub expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Memory {
    pub fn is_expired(&self) -> bool {
        self.expires_at.as_deref().is_some_and(super::time::is_past)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryLink {
    pub from_id: String,
    pub to_id: String,
    pub relation: Relation,
    pub created_at: String,
}

pub const MAX_TITLE: usize = 120;
pub const MAX_BODY: usize = 6_000;
pub const MAX_TAGS: usize = 8;
pub const MAX_TAG: usize = 32;
/// How long a working memory lasts when nobody says.
pub const WORKING_DAYS: i64 = 14;

fn invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorCode::Invalid, message)
}

pub fn clean_title(title: &str) -> Result<String> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err(invalid("a memory needs a title"));
    }
    if title.chars().count() > MAX_TITLE {
        return Err(invalid(format!(
            "a memory title has at most {MAX_TITLE} characters; put the detail in the body"
        )));
    }
    Ok(title)
}

pub fn clean_body(body: &str) -> Result<String> {
    let body = body.trim();
    if body.is_empty() {
        return Err(invalid("a memory needs a body"));
    }
    if body.chars().count() > MAX_BODY {
        return Err(invalid(format!(
            "a memory body has at most {MAX_BODY} characters; split it into linked memories"
        )));
    }
    Ok(body.to_string())
}

/// Tags as stored: lowercase, one word each (letters, digits, `-`, `_`, `.`, `/`), no repeats.
pub fn clean_tags(tags: &[String]) -> Result<Vec<String>> {
    let mut clean: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim().to_lowercase().replace(' ', "-");
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > MAX_TAG
            || !tag
                .chars()
                .all(|ch| ch.is_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '#'))
        {
            return Err(invalid(format!(
                "tag \"{tag}\" is not valid: one short word of letters, digits or - _ . / :"
            )));
        }
        if !clean.contains(&tag) {
            clean.push(tag);
        }
    }
    if clean.len() > MAX_TAGS {
        return Err(invalid(format!("a memory has at most {MAX_TAGS} tags")));
    }
    Ok(clean)
}

/// Refuses text that carries a credential. Memories are shown to every agent and kept in the
/// open, so a key or a password in one is a leak that outlives the chat it came from.
pub fn refuse_secrets(text: &str) -> Result<()> {
    if text.contains("-----BEGIN ") {
        return Err(secret_error("a private key"));
    }
    let parts: Vec<&str> = text
        .split(|ch: char| {
            ch.is_whitespace() || matches!(ch, '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '<' | '>')
        })
        .collect();
    for (index, raw) in parts.iter().enumerate() {
        let word = raw.trim_matches(|ch: char| matches!(ch, '.' | ':' | '[' | ']'));
        let lower = word.to_ascii_lowercase();
        let long = word.len() >= 20;
        let looks_like_token = (lower.starts_with("sk-") && word.len() >= 24)
            || (["ghp_", "gho_", "ghs_", "ghu_", "github_pat_", "glpat-"]
                .iter()
                .any(|prefix| lower.starts_with(prefix))
                && long)
            || (lower.starts_with("xox") && word.len() >= 20 && word.contains('-'))
            || (word.starts_with("AKIA")
                && word.len() == 20
                && word
                    .chars()
                    .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit()))
            || (word.starts_with("eyJ") && word.matches('.').count() == 2 && word.len() >= 40);
        if looks_like_token {
            return Err(secret_error("an access token or key"));
        }
        // `password=value`, `password: value` and `password = value`.
        let raw_lower = raw.to_ascii_lowercase();
        let (name, value) = match raw_lower.split_once(['=', ':']) {
            Some((name, value)) if !value.is_empty() => (name.to_string(), value.to_string()),
            Some((name, _)) => (
                name.to_string(),
                parts
                    .get(index + 1)
                    .copied()
                    .unwrap_or("")
                    .to_ascii_lowercase(),
            ),
            None if parts.get(index + 1).is_some_and(|next| *next == "=") => (
                raw_lower.clone(),
                parts
                    .get(index + 2)
                    .copied()
                    .unwrap_or("")
                    .to_ascii_lowercase(),
            ),
            None => continue,
        };
        let is_secret_name = ["password", "passwd", "secret", "token", "api_key", "apikey"]
            .iter()
            .any(|key| name.ends_with(key));
        if is_secret_name
            && value.len() >= 8
            && value.chars().any(|ch| ch.is_ascii_digit())
            && !value.starts_with("http")
        {
            return Err(secret_error("a password or secret"));
        }
    }
    Ok(())
}

fn secret_error(what: &str) -> Error {
    invalid(format!(
        "this looks like {what}. Memories are shared with every agent and never hold secrets: say where it is kept instead"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_sources_and_relations_round_trip_through_their_names() {
        for kind in MemoryKind::ALL {
            assert_eq!(MemoryKind::parse(kind.as_str()), Some(kind));
        }
        for relation in Relation::ALL {
            assert_eq!(Relation::parse(relation.as_str()), Some(relation));
        }
        assert_eq!(
            MemorySource::parse("observed"),
            Some(MemorySource::Observed)
        );
        assert_eq!(MemoryKind::parse("dream"), None);
        assert_eq!(Relation::parse("loves"), None);
        let json = serde_json::to_string(&Relation::CausedBy).unwrap();
        assert_eq!(json, "\"caused_by\"");
    }

    #[test]
    fn titles_are_one_line_and_tags_are_one_short_word() {
        assert_eq!(
            clean_title("  Redis  for\nlatency ").unwrap(),
            "Redis for latency"
        );
        assert!(clean_title("   ").is_err());
        assert!(clean_title(&"x".repeat(MAX_TITLE + 1)).is_err());
        let tags = clean_tags(&[
            "Redis".into(),
            "redis".into(),
            "Build Tool".into(),
            " ".into(),
        ])
        .unwrap();
        assert_eq!(tags, vec!["redis", "build-tool"]);
        assert!(clean_tags(&["no!way".into()]).is_err());
        assert!(clean_tags(&(0..9).map(|n| format!("t{n}")).collect::<Vec<_>>()).is_err());
    }

    #[test]
    fn a_credential_is_refused_and_a_plain_note_is_not() {
        for text in [
            "use sk-abcdefghijklmnopqrstuvwxyz123456 to call it",
            "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "-----BEGIN RSA PRIVATE KEY-----",
            "the key is AKIAABCDEFGHIJKLMNOP",
            "set PASSWORD=hunter2hunter2 first",
            "api_key: 9f8e7d6c5b4a3b2c",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
        ] {
            assert!(refuse_secrets(text).is_err(), "{text}");
        }
        for text in [
            "Tokens are checked with SHA-256, not a slow hash",
            "the password reset email is sent by the auth service",
            "see https://example.test/docs?token=abc for the flow",
            "run `pnpm test` before the push",
        ] {
            assert!(refuse_secrets(text).is_ok(), "{text}");
        }
    }

    #[test]
    fn only_a_past_moment_has_expired() {
        let mut memory = Memory {
            id: "m".into(),
            kind: MemoryKind::Working,
            workspace_id: None,
            title: "t".into(),
            body: "b".into(),
            tags: vec![],
            source: MemorySource::Observed,
            author: MemoryAuthor::Agent,
            expires_at: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        assert!(!memory.is_expired());
        memory.expires_at = Some("2020-01-01T00:00:00Z".into());
        assert!(memory.is_expired());
        memory.expires_at = Some(crate::domain::time::in_days(3).unwrap());
        assert!(!memory.is_expired());
    }
}
