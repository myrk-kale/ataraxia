//! Titles for new chats: once the first exchange is over, the chat's own harness is asked for a few
//! words that say what it is about, and the chat is renamed to them.
//!
//! Only chats made after this existed are titled. A new chat is marked when it is created (see
//! [`mark_for_title`]); a chat without the mark, which is every chat that was already there, is
//! never touched, and neither is one that was given a title on purpose.

use std::sync::Arc;

use super::engine::Engine;
use crate::domain::ids::SessionId;
use crate::domain::{ChatItem, ChatRole, ChatSession, InsightEvent, Result, SessionKind};
use crate::ports::Store;

/// Tries before giving up on a chat: a harness that cannot answer must not be asked every turn.
const MAX_ATTEMPTS: u32 = 3;
/// How much of the first exchange the model is shown.
const MAX_ASKED_CHARS: usize = 1_500;
const MAX_ANSWER_CHARS: usize = 1_500;
/// The longest title kept.
const MAX_TITLE_CHARS: usize = 60;

fn key(session_id: SessionId) -> String {
    format!("auto_title:{}", session_id.0)
}

/// Makes a chat that was just created wait for its title.
pub fn mark_for_title(store: &dyn Store, session_id: SessionId) -> Result<()> {
    store.set_preference(&key(session_id), "pending:0")
}

/// How many tries a marked chat has used, or `None` when it is not waiting for a title.
fn attempts(store: &dyn Store, session_id: SessionId) -> Option<u32> {
    let value = store.get_preference(&key(session_id)).ok().flatten()?;
    value.strip_prefix("pending:")?.parse().ok()
}

/// The title a model answered with, cleaned: the first line without quotes, markdown, a leading
/// "Title:" or a closing full stop, and not longer than [`MAX_TITLE_CHARS`].
pub(crate) fn clean_title(answer: &str) -> Option<String> {
    let line = answer
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let mut title = line.trim_start_matches('#').trim();
    for label in ["title:", "título:", "titulo:"] {
        if title.len() >= label.len()
            && title.is_char_boundary(label.len())
            && title[..label.len()].eq_ignore_ascii_case(label)
        {
            title = title[label.len()..].trim();
        }
    }
    let decoration = |c: char| {
        matches!(
            c,
            '"' | '\'' | '`' | '*' | '_' | '“' | '”' | '‘' | '’' | '«' | '»'
        )
    };
    let title = title
        .trim_matches(decoration)
        .trim_end_matches(['.', '。'])
        .trim_matches(decoration)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        return None;
    }
    Some(
        title
            .chars()
            .take(MAX_TITLE_CHARS)
            .collect::<String>()
            .trim_end()
            .to_string(),
    )
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.trim().to_string()
    } else {
        text.chars()
            .take(max)
            .collect::<String>()
            .trim()
            .to_string()
            + "…"
    }
}

/// The prompt that asks for a title. `ATARAXIA_TASK:title` is what the fake agent of the tests
/// recognises.
fn prompt(asked: &str, answered: &str) -> String {
    format!(
        "ATARAXIA_TASK:title\n\
         Write a title for a conversation between a developer and a coding agent, from its first exchange below.\n\
         - At most six words, in the language the developer wrote in.\n\
         - Say what the conversation is about, not what the agent did: \"Fix login redirect\", not \"Looking into the issue\".\n\
         - No quotes, no full stop, no markdown, nothing before or after it.\n\
         - Use no tools and read no files. Answer with the title alone.\n\n\
         Developer:\n{asked}\n\nAgent:\n{answered}\n"
    )
}

/// A default title such as `Chat 4`: the only kind that may be replaced.
fn is_default_title(title: &str) -> bool {
    title
        .strip_prefix("Chat ")
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
}

impl Engine {
    /// Called when a turn of a chat ends well: names the chat if it is waiting for a name. The work
    /// is done on its own thread; the chat does not wait for it.
    pub(crate) fn title_chat(self: &Arc<Self>, session: &ChatSession) {
        if session.kind != SessionKind::Chat || attempts(self.db.as_ref(), session.id).is_none() {
            return;
        }
        let engine = Arc::clone(self);
        let session = session.clone();
        std::thread::spawn(move || engine.run_title(&session));
    }

    pub(crate) fn run_title(&self, session: &ChatSession) {
        let Some(used) = attempts(self.db.as_ref(), session.id) else {
            return;
        };
        let Some((asked, answered)) = self.first_exchange(session.id) else {
            // Nothing to go on yet: this does not count as a try.
            return;
        };
        // Taken before the slow part, so a second end of turn does not start a second one.
        let _ = self.db.set_preference(&key(session.id), "running");
        match self.ask_for_title(session, &asked, &answered) {
            Ok(title) => {
                let current = self.db.get_session(session.id).ok().flatten();
                let free = current
                    .as_ref()
                    .is_some_and(|now| is_default_title(&now.title));
                if free && self.db.update_session_title(session.id, &title).is_ok() {
                    self.sink.emit_insight(InsightEvent::SessionTitle {
                        session_id: session.id,
                        title,
                    });
                }
                let _ = self.db.set_preference(&key(session.id), "done");
            }
            Err(error) => {
                eprintln!("ataraxia: could not title a chat: {error}");
                let next = if used + 1 >= MAX_ATTEMPTS {
                    "done".to_string()
                } else {
                    format!("pending:{}", used + 1)
                };
                let _ = self.db.set_preference(&key(session.id), &next);
            }
        }
    }

    /// What the developer first asked and what the agent first answered, when it has.
    fn first_exchange(&self, session_id: SessionId) -> Option<(String, String)> {
        let items = self
            .runtime
            .snapshot(&session_id)
            .map(|snapshot| snapshot.items)
            .ok()
            .filter(|items| !items.is_empty())
            .or_else(|| self.db.list_chat_items(session_id).ok())?;
        let first = items.iter().position(
            |item| matches!(item, ChatItem::Message(m) if m.role == ChatRole::User && !m.text.trim().is_empty()),
        )?;
        let ChatItem::Message(asked) = &items[first] else {
            return None;
        };
        let answered = items[first + 1..]
            .iter()
            .take_while(|item| !matches!(item, ChatItem::Message(m) if m.role == ChatRole::User))
            .filter_map(|item| match item {
                ChatItem::Message(m) if m.role == ChatRole::Assistant => Some(m.text.trim()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        if answered.is_empty() {
            return None;
        }
        Some((
            clip(&asked.text, MAX_ASKED_CHARS),
            clip(&answered, MAX_ANSWER_CHARS),
        ))
    }

    fn ask_for_title(&self, session: &ChatSession, asked: &str, answered: &str) -> Result<String> {
        // The chat's own harness, on its default model: this is a few words, not a task.
        let hidden = self.hidden_session_with(
            session,
            SessionKind::Analysis,
            "Chat title",
            Some(session.provider),
            None,
        )?;
        let answer = self.ask_and_wait(&hidden, &prompt(asked, answered));
        // The helper is not worth keeping: nobody will open it.
        let _ = self.db.delete_session(hidden.id);
        self.runtime.forget_session(&hidden.id);
        clean_title(&answer?).ok_or_else(|| {
            crate::domain::Error::new(crate::domain::ErrorCode::Agent, "the agent gave no title")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_is_made_of_the_first_line_without_decoration() {
        assert_eq!(
            clean_title("Fix login redirect"),
            Some("Fix login redirect".into())
        );
        assert_eq!(
            clean_title("\n  \"Fix login redirect.\"  \nBecause…"),
            Some("Fix login redirect".into())
        );
        assert_eq!(
            clean_title("Title: **Corrigir o login**"),
            Some("Corrigir o login".into())
        );
        assert_eq!(
            clean_title("# Título: «Ajustar testes»."),
            Some("Ajustar testes".into())
        );
        assert_eq!(
            clean_title("`Fix   the  tests`"),
            Some("Fix the tests".into())
        );
        assert_eq!(clean_title("  \n \n"), None);
        assert_eq!(clean_title("\"\""), None);
        let long = clean_title(&"word ".repeat(40)).unwrap();
        assert!(long.chars().count() <= MAX_TITLE_CHARS && !long.ends_with(' '));
    }

    #[test]
    fn only_a_default_title_may_be_replaced() {
        assert!(is_default_title("Chat 4"));
        assert!(is_default_title("Chat 12"));
        assert!(!is_default_title("Chat"));
        assert!(!is_default_title("Chat about login"));
        assert!(!is_default_title("Release 0.14"));
    }
}
