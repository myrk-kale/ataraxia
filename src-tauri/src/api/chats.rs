//! The other conversations of a chat's workspace, for its agent to find its way in and read.
//!
//! Three read-only tools of the `ataraxia` MCP server: `chats_list` says what there is,
//! `chats_search` is a grep over what was said (every hit says whether the developer or an agent
//! said it), and `chats_read` opens a window of one conversation at a time, so a long one is read
//! a piece at a time and never whole. A chat sees only the chats of its own workspace, and never
//! itself: it already has that conversation.

use regex::RegexBuilder;
use serde_json::{Value, json};

use super::{ApiError, ApiResult, ApiService, not_found};
use crate::domain::ids::WorkspaceId;
use crate::domain::{ChatItem, ChatRole, ChatSession};

/// What `chats_search` and `chats_read` hand back at most, in characters of conversation.
const REPLY_BUDGET: usize = 40_000;
const FIRST_WORDS: usize = 140;
const LINE_WIDTH: usize = 240;
const LINES_PER_HIT: usize = 3;

fn bad(message: impl Into<String>) -> ApiError {
    ApiError::invalid(message)
}

fn text<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn number(args: &Value, key: &str) -> Option<usize> {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
}

fn flag(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// One thing said in a conversation, as the agent reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Entry {
    /// Its place in the conversation: what `chats_read` takes as `from`, `before` or `around`.
    pub index: usize,
    /// `user` is the developer, `agent` is the assistant, `tool` is a tool call and its result.
    pub role: &'static str,
    pub text: String,
}

/// The conversation as entries. The agent's reasoning is never shown: it was not said to anyone.
pub(super) fn entries(items: &[ChatItem], tools: bool) -> Vec<Entry> {
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| match item {
            ChatItem::Message(message) => {
                let role = match message.role {
                    ChatRole::User => "user",
                    ChatRole::Assistant => "agent",
                    ChatRole::System => "system",
                    ChatRole::Reasoning => return None,
                };
                Some(Entry {
                    index,
                    role,
                    text: message.text.clone(),
                })
            }
            ChatItem::Tool(call) if tools => Some(Entry {
                index,
                role: "tool",
                text: match &call.output {
                    Some(output) => format!("{} {}\n=> {output}", call.name, call.input),
                    None => format!("{} {}", call.name, call.input),
                },
            }),
            ChatItem::Tool(_) => None,
        })
        .collect()
}

/// The part of a line around the first match, so a long line shows what was found in it.
fn clip_around(line: &str, at: usize, width: usize) -> String {
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= width {
        return line.trim().to_string();
    }
    let at_char = line[..at].chars().count();
    let start = at_char.saturating_sub(width / 3);
    let end = (start + width).min(chars.len());
    let mut shown: String = chars[start..end].iter().collect();
    if start > 0 {
        shown.insert(0, '…');
    }
    if end < chars.len() {
        shown.push('…');
    }
    shown.trim().to_string()
}

fn clip_start(value: &str, width: usize) -> String {
    let flat = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= width {
        flat
    } else {
        flat.chars().take(width).collect::<String>() + "…"
    }
}

/// The chat a key names: its id, the start of its id, or its title (whole, or a part of it).
/// A title that two chats share is told apart by ` #` and the start of the id, which is how the
/// `@` picker writes one.
pub(super) fn resolve<'a>(sessions: &'a [ChatSession], key: &str) -> ApiResult<&'a ChatSession> {
    let mut key = key.trim();
    if let Some(rest) = key
        .get(..5)
        .filter(|head| head.eq_ignore_ascii_case("chat:"))
        .map(|_| &key[5..])
    {
        key = rest.trim();
    }
    // The picker escapes a quote or a backslash of the title with a backslash.
    let quoted = key.strip_prefix('"').unwrap_or(key);
    let quoted = quoted.strip_suffix('"').unwrap_or(quoted);
    let unescaped = quoted.trim().replace("\\\"", "\"").replace("\\\\", "\\");
    let key = unescaped.as_str();
    let (title, suffix) = match key.rsplit_once(" #") {
        Some((title, suffix))
            if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_hexdigit()) =>
        {
            (title.trim(), Some(suffix.to_ascii_lowercase()))
        }
        _ => (key, None),
    };
    let id_of = |session: &ChatSession| session.id.0.to_string();
    let by_id = |prefix: &str| -> Vec<&ChatSession> {
        sessions
            .iter()
            .filter(|session| id_of(session).starts_with(prefix))
            .collect()
    };
    let lower = key.to_ascii_lowercase();
    if lower.len() >= 4 && lower.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        let found = by_id(&lower);
        if found.len() == 1 {
            return Ok(found[0]);
        }
    }
    let wanted = title.to_lowercase();
    let named = |exact: bool| -> Vec<&ChatSession> {
        sessions
            .iter()
            .filter(|session| {
                let name = session.title.to_lowercase();
                let fits = if exact {
                    name == wanted
                } else {
                    name.contains(&wanted)
                };
                fits && suffix
                    .as_deref()
                    .is_none_or(|suffix| id_of(session).starts_with(suffix))
            })
            .collect()
    };
    let mut found = named(true);
    if found.is_empty() {
        found = named(false);
    }
    match found.as_slice() {
        [one] => Ok(one),
        [] => Err(not_found(&format!(
            "no other chat of this workspace is called or starts with \"{key}\": call chats_list to see them"
        ))),
        many => Err(bad(format!(
            "more than one chat fits \"{key}\": give the id of one of them: {}",
            many.iter()
                .take(6)
                .map(|session| format!("\"{}\" ({})", session.title, session.id.0))
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

impl ApiService {
    /// The workspace this chat belongs to: the only chats it may read are in it.
    pub(super) fn chats_workspace(&self) -> Option<WorkspaceId> {
        self.db
            .get_session(self.scope)
            .ok()
            .flatten()
            .and_then(|session| session.workspace_id)
    }

    /// The other chats of the workspace, most recently used first.
    fn other_chats(&self) -> ApiResult<Vec<ChatSession>> {
        let workspace = self.chats_workspace().ok_or_else(|| {
            bad("this chat belongs to no workspace, so there are no other conversations to read")
        })?;
        Ok(self
            .db
            .list_workspace_sessions(workspace)?
            .into_iter()
            .filter(|session| session.id != self.scope)
            .collect())
    }

    /// Runs one of the chat tools; `None` when `name` is not one of them.
    pub(super) fn run_chat_tool(&self, name: &str, args: &Value) -> Option<ApiResult<Value>> {
        Some(match name {
            "chats_list" => self.chats_list(args),
            "chats_search" => self.chats_search(args),
            "chats_read" => self.chats_read(args),
            _ => return None,
        })
    }

    fn chats_list(&self, args: &Value) -> ApiResult<Value> {
        let limit = number(args, "limit").map_or(30, |limit| limit.clamp(1, 100));
        let chats = self.other_chats()?;
        let total = chats.len();
        let mut listed = Vec::new();
        for session in chats.iter().take(limit) {
            let items = self.db.list_chat_items(session.id)?;
            let said = entries(&items, false);
            let first = said
                .iter()
                .find(|entry| entry.role == "user")
                .map(|entry| clip_start(&entry.text, FIRST_WORDS));
            listed.push(json!({
                "id": session.id.0,
                "title": session.title,
                "status": session.status.as_str(),
                "updated_at": session.updated_at,
                "messages": said.iter().filter(|entry| entry.role != "system").count(),
                "first_user_message": first,
            }));
        }
        Ok(json!({
            "count": listed.len(),
            "total": total,
            "chats": listed,
            "note": "Most recently used first. Find what you need with chats_search, then open it with chats_read."
        }))
    }

    fn chats_search(&self, args: &Value) -> ApiResult<Value> {
        let pattern = text(args, "pattern")
            .filter(|pattern| !pattern.is_empty())
            .ok_or_else(|| bad("`pattern` is required"))?;
        let source = if flag(args, "regex") {
            pattern.to_string()
        } else {
            regex::escape(pattern)
        };
        let matcher = RegexBuilder::new(&source)
            .case_insensitive(!flag(args, "case_sensitive"))
            .size_limit(1 << 20)
            .build()
            .map_err(|error| {
                bad(format!(
                    "`pattern` is not a valid regular expression: {error}"
                ))
            })?;
        let (messages, tools) = match text(args, "role").unwrap_or("any") {
            "any" => (None, true),
            "user" => (Some("user"), false),
            "agent" => (Some("agent"), false),
            "tool" => (Some("tool"), true),
            _ => return Err(bad("`role` must be user, agent, tool or any")),
        };
        let limit = number(args, "limit").map_or(20, |limit| limit.clamp(1, 50));
        let mut chats = self.other_chats()?;
        if let Some(key) = text(args, "chat") {
            let one = resolve(&chats, key)?.id;
            chats.retain(|session| session.id == one);
        }
        let mut hits = Vec::new();
        let mut spent = 0;
        let mut more = false;
        'chats: for session in &chats {
            let items = self.db.list_chat_items(session.id)?;
            for entry in entries(&items, tools) {
                if messages.is_some_and(|role| entry.role != role) {
                    continue;
                }
                let mut lines = Vec::new();
                let mut count = 0;
                for (number, line) in entry.text.lines().enumerate() {
                    if let Some(found) = matcher.find(line) {
                        count += 1;
                        if lines.len() < LINES_PER_HIT {
                            lines.push(json!({
                                "line": number + 1,
                                "text": clip_around(line, found.start(), LINE_WIDTH)
                            }));
                        }
                    }
                }
                if count == 0 {
                    continue;
                }
                if hits.len() == limit || spent > REPLY_BUDGET {
                    more = true;
                    break 'chats;
                }
                spent += lines
                    .iter()
                    .map(|line| line.to_string().len())
                    .sum::<usize>();
                hits.push(json!({
                    "chat": session.id.0,
                    "title": session.title,
                    "index": entry.index,
                    "role": entry.role,
                    "matching_lines": count,
                    "lines": lines,
                }));
            }
        }
        Ok(json!({
            "count": hits.len(),
            "more": more,
            "hits": hits,
            "note": "role says who wrote it: user is the developer, agent is the assistant. Open a hit with chats_read using its chat and `around` set to its index."
        }))
    }

    fn chats_read(&self, args: &Value) -> ApiResult<Value> {
        let chats = self.other_chats()?;
        let key = text(args, "chat").ok_or_else(|| bad("`chat` is required (an id or a title)"))?;
        let session = resolve(&chats, key)?;
        let items = self.db.list_chat_items(session.id)?;
        let all = entries(&items, flag(args, "include_tools"));
        let count = number(args, "count").map_or(6, |count| count.clamp(1, 20));
        let max_chars = number(args, "max_chars").map_or(2_000, |chars| chars.clamp(200, 20_000));
        // Where in `all` the window starts.
        let ends_before =
            number(args, "before").map(|before| all.partition_point(|entry| entry.index < before));
        let first = if let Some(end) = ends_before {
            end.saturating_sub(count)
        } else if let Some(around) = number(args, "around") {
            all.partition_point(|entry| entry.index < around)
                .saturating_sub(count / 2)
        } else if flag(args, "tail") {
            all.len().saturating_sub(count)
        } else {
            all.partition_point(|entry| entry.index < number(args, "from").unwrap_or(0))
        };
        let offset = number(args, "offset").unwrap_or(0);
        let mut shown = Vec::new();
        let mut spent = 0;
        let mut next = None;
        for (position, entry) in all.iter().enumerate().skip(first) {
            if ends_before.is_some_and(|end| position >= end) {
                break;
            }
            if shown.len() == count || (!shown.is_empty() && spent >= REPLY_BUDGET) {
                next = Some(position);
                break;
            }
            // Only the first entry can be read from the middle: that is how a long one goes on.
            let skip = if shown.is_empty() { offset } else { 0 };
            let total = entry.text.chars().count();
            let body: String = entry.text.chars().skip(skip).take(max_chars).collect();
            let cut = skip + body.chars().count() < total;
            spent += body.len();
            let mut value = json!({
                "index": entry.index,
                "role": entry.role,
                "text": body,
            });
            if skip > 0 {
                value["from_char"] = json!(skip);
            }
            if cut {
                value["truncated"] = json!(true);
                value["next_offset"] = json!(skip + max_chars);
                value["chars"] = json!(total);
            }
            shown.push(value);
        }
        let top = shown.first().map(|value| value["index"].clone());
        let cut = shown.iter().any(|value| value["truncated"] == true);
        let mut reply = json!({
            "chat": session.id.0,
            "title": session.title,
            "entries": all.len(),
            "messages": shown,
        });
        if let Some(position) = next {
            reply["next_from"] = json!(all[position].index);
        }
        if first > 0
            && let Some(top) = top
        {
            reply["earlier_than"] = top;
        }
        if cut {
            reply["note"] = json!(
                "A message was cut: read the rest with the same `from` (its index) and `offset` set to its next_offset."
            );
        }
        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::adapters::sqlite::SqliteStore;
    use crate::domain::agent::ProviderKind;
    use crate::domain::ids::{RepositoryId, SessionId, WorktreeId};
    use crate::domain::{
        ChatMessage, Repository, SessionKind, SessionStatus, ToolCallId, ToolCallRecord,
        ToolStatus, Workspace, Worktree,
    };
    use crate::ports::Store;

    fn message(role: ChatRole, text: &str) -> ChatItem {
        ChatItem::Message(ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            role,
            text: text.into(),
            turn_id: None,
            images: Vec::new(),
        })
    }

    struct World {
        db: Arc<SqliteStore>,
        workspace: WorkspaceId,
        repo: RepositoryId,
        worktree: WorktreeId,
    }

    fn world() -> World {
        let db = Arc::new(SqliteStore::open_in_memory().unwrap());
        let now = "2026-01-01T00:00:00Z".to_string();
        let repo = Repository {
            id: RepositoryId::new(),
            root: "/r".into(),
            name: "r".into(),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        db.upsert_repository(&repo).unwrap();
        let worktree = Worktree {
            id: WorktreeId::new(),
            repository_id: repo.id,
            path: "/r".into(),
            branch: None,
            head: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        db.upsert_worktree(&worktree).unwrap();
        let workspace = Workspace {
            id: WorkspaceId::new(),
            name: "w".into(),
            repository_ids: vec![repo.id],
            created_at: now.clone(),
            updated_at: now,
        };
        db.upsert_workspace(&workspace).unwrap();
        World {
            db,
            workspace: workspace.id,
            repo: repo.id,
            worktree: worktree.id,
        }
    }

    fn chat(world: &World, title: &str, in_workspace: bool, items: &[ChatItem]) -> SessionId {
        let now = "2026-01-01T00:00:00Z".to_string();
        let session = ChatSession {
            id: SessionId::new(),
            workspace_id: in_workspace.then_some(world.workspace),
            repository_id: world.repo,
            worktree_id: world.worktree,
            provider: ProviderKind::Fake,
            title: title.into(),
            status: SessionStatus::Idle,
            model: None,
            effort: None,
            agent: None,
            kind: SessionKind::Chat,
            parent_session_id: None,
            created_at: now.clone(),
            updated_at: now,
            last_opened_at: None,
        };
        world.db.create_session(&session).unwrap();
        world.db.replace_chat_items(session.id, items).unwrap();
        session.id
    }

    fn api_for(world: &World, scope: SessionId) -> ApiService {
        ApiService::new(world.db.clone(), scope, false)
    }

    fn run(service: &ApiService, name: &str, args: Value) -> ApiResult<Value> {
        service.run_chat_tool(name, &args).expect("a chat tool")
    }

    #[test]
    fn entries_keep_who_said_it_and_leave_the_reasoning_out() {
        let items = vec![
            message(ChatRole::User, "how do I log in?"),
            message(ChatRole::Reasoning, "thinking…"),
            message(ChatRole::Assistant, "with a token"),
            ChatItem::Tool(ToolCallRecord {
                call_id: ToolCallId::new(),
                turn_id: crate::domain::ids::TurnId(uuid::Uuid::new_v4()),
                name: "Bash".into(),
                input: "ls".into(),
                output: Some("a.py".into()),
                status: ToolStatus::Done,
            }),
        ];
        let said = entries(&items, false);
        assert_eq!(
            said.iter().map(|e| (e.index, e.role)).collect::<Vec<_>>(),
            vec![(0, "user"), (2, "agent")]
        );
        let all = entries(&items, true);
        assert_eq!(all.last().map(|e| (e.index, e.role)), Some((3, "tool")));
        assert!(all.last().unwrap().text.contains("=> a.py"));
    }

    #[test]
    fn a_chat_sees_the_others_of_its_workspace_and_neither_itself_nor_strangers() {
        let w = world();
        let me = chat(&w, "me", true, &[message(ChatRole::User, "secret of mine")]);
        chat(
            &w,
            "Login bug",
            true,
            &[message(ChatRole::User, "login fails with 401")],
        );
        chat(
            &w,
            "elsewhere",
            false,
            &[message(ChatRole::User, "login in another place")],
        );
        let service = api_for(&w, me);
        let listed = run(&service, "chats_list", json!({})).unwrap();
        assert_eq!(listed["total"], 1);
        assert_eq!(listed["chats"][0]["title"], "Login bug");
        assert_eq!(
            listed["chats"][0]["first_user_message"],
            "login fails with 401"
        );
        let found = run(&service, "chats_search", json!({ "pattern": "login" })).unwrap();
        assert_eq!(found["count"], 1);
        assert_eq!(found["hits"][0]["title"], "Login bug");
        assert_eq!(
            run(&service, "chats_search", json!({ "pattern": "secret" })).unwrap()["count"],
            0
        );
        // A chat outside any workspace has nobody to look at.
        let alone = chat(&w, "alone", false, &[]);
        assert!(run(&api_for(&w, alone), "chats_list", json!({})).is_err());
    }

    #[test]
    fn search_tells_the_developer_from_the_agent_and_can_be_narrowed() {
        let w = world();
        let me = chat(&w, "me", true, &[]);
        let other = chat(
            &w,
            "Deploy",
            true,
            &[
                message(ChatRole::User, "can we deploy on Friday?"),
                message(
                    ChatRole::Assistant,
                    "Deploy is blocked.\nThe deploy script fails on step 3.",
                ),
            ],
        );
        let service = api_for(&w, me);
        let found = run(&service, "chats_search", json!({ "pattern": "DEPLOY" })).unwrap();
        assert_eq!(found["count"], 2);
        assert_eq!(found["hits"][0]["role"], "user");
        assert_eq!(found["hits"][1]["role"], "agent");
        assert_eq!(found["hits"][1]["matching_lines"], 2);
        assert_eq!(found["hits"][1]["lines"][1]["line"], 2);
        let only_agent = run(
            &service,
            "chats_search",
            json!({ "pattern": "deploy", "role": "agent" }),
        )
        .unwrap();
        assert_eq!(only_agent["count"], 1);
        let sensitive = run(
            &service,
            "chats_search",
            json!({ "pattern": "DEPLOY", "case_sensitive": true }),
        )
        .unwrap();
        assert_eq!(sensitive["count"], 0);
        let pattern = run(
            &service,
            "chats_search",
            json!({ "pattern": "step \\d", "regex": true, "chat": other.0.to_string() }),
        )
        .unwrap();
        assert_eq!(pattern["count"], 1);
        // Characters that mean something in a regular expression are plain text unless asked.
        assert_eq!(
            run(&service, "chats_search", json!({ "pattern": "step (" })).unwrap()["count"],
            0
        );
        assert!(
            run(
                &service,
                "chats_search",
                json!({ "pattern": "step (", "regex": true })
            )
            .is_err()
        );
        assert!(
            run(
                &service,
                "chats_search",
                json!({ "pattern": "x", "role": "nobody" })
            )
            .is_err()
        );
    }

    #[test]
    fn reading_goes_a_window_at_a_time_in_both_directions() {
        let w = world();
        let me = chat(&w, "me", true, &[]);
        let items: Vec<ChatItem> = (0..10)
            .map(|n| {
                message(
                    if n % 2 == 0 {
                        ChatRole::User
                    } else {
                        ChatRole::Assistant
                    },
                    &format!("message {n}"),
                )
            })
            .collect();
        chat(&w, "Long talk", true, &items);
        let service = api_for(&w, me);
        let first = run(
            &service,
            "chats_read",
            json!({ "chat": "long talk", "count": 3 }),
        )
        .unwrap();
        let indexes = |reply: &Value| -> Vec<u64> {
            reply["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["index"].as_u64().unwrap())
                .collect()
        };
        assert_eq!(indexes(&first), vec![0, 1, 2]);
        assert_eq!(first["messages"][1]["role"], "agent");
        assert_eq!(first["next_from"], 3);
        assert!(first.get("earlier_than").is_none());
        let next = run(
            &service,
            "chats_read",
            json!({ "chat": "Long talk", "from": 3, "count": 3 }),
        )
        .unwrap();
        assert_eq!(indexes(&next), vec![3, 4, 5]);
        assert_eq!(next["earlier_than"], 3);
        let tail = run(
            &service,
            "chats_read",
            json!({ "chat": "Long talk", "tail": true, "count": 2 }),
        )
        .unwrap();
        assert_eq!(indexes(&tail), vec![8, 9]);
        assert!(tail.get("next_from").is_none());
        let around = run(
            &service,
            "chats_read",
            json!({ "chat": "Long talk", "around": 5, "count": 4 }),
        )
        .unwrap();
        assert_eq!(indexes(&around), vec![3, 4, 5, 6]);
        let before = run(
            &service,
            "chats_read",
            json!({ "chat": "Long talk", "before": 3, "count": 5 }),
        )
        .unwrap();
        assert_eq!(indexes(&before), vec![0, 1, 2]);
    }

    #[test]
    fn a_long_message_is_cut_and_read_on_with_an_offset() {
        let w = world();
        let me = chat(&w, "me", true, &[]);
        let long = "abcdefghij".repeat(100);
        chat(&w, "Essay", true, &[message(ChatRole::Assistant, &long)]);
        let service = api_for(&w, me);
        let part = run(
            &service,
            "chats_read",
            json!({ "chat": "Essay", "max_chars": 200 }),
        )
        .unwrap();
        assert_eq!(part["messages"][0]["text"].as_str().unwrap().len(), 200);
        assert_eq!(part["messages"][0]["truncated"], true);
        assert_eq!(part["messages"][0]["chars"], 1000);
        let rest = run(
            &service,
            "chats_read",
            json!({ "chat": "Essay", "max_chars": 200, "offset": 200 }),
        )
        .unwrap();
        assert_eq!(rest["messages"][0]["next_offset"], 400);
        assert_eq!(rest["messages"][0]["from_char"], 200);
        let end = run(
            &service,
            "chats_read",
            json!({ "chat": "Essay", "max_chars": 300, "offset": 800 }),
        )
        .unwrap();
        assert_eq!(end["messages"][0]["text"].as_str().unwrap().len(), 200);
        assert!(end["messages"][0].get("truncated").is_none());
    }

    #[test]
    fn a_chat_is_found_by_id_by_title_and_by_the_pickers_disambiguation() {
        let w = world();
        let me = chat(&w, "me", true, &[]);
        let a = chat(&w, "New chat", true, &[message(ChatRole::User, "first")]);
        let b = chat(&w, "New chat", true, &[message(ChatRole::User, "second")]);
        chat(&w, "Refactor auth", true, &[]);
        chat(&w, "Say \"hi\"", true, &[]);
        let service = api_for(&w, me);
        let read = |key: String| run(&service, "chats_read", json!({ "chat": key }));
        assert_eq!(
            read(a.0.to_string()).unwrap()["messages"][0]["text"],
            "first"
        );
        assert_eq!(
            read(a.0.to_string()[..8].to_string()).unwrap()["messages"][0]["text"],
            "first"
        );
        assert_eq!(
            read("chat:\"Refactor AUTH\"".into()).unwrap()["title"],
            "Refactor auth"
        );
        assert_eq!(read("refactor".into()).unwrap()["title"], "Refactor auth");
        assert_eq!(
            read(r#"chat:"Say \"hi\"""#.into()).unwrap()["title"],
            "Say \"hi\""
        );
        let ambiguous = read("New chat".into()).unwrap_err();
        assert!(
            ambiguous.message.contains(&a.0.to_string())
                && ambiguous.message.contains(&b.0.to_string())
        );
        let told_apart = format!("New chat #{}", &b.0.to_string()[..8]);
        assert_eq!(read(told_apart).unwrap()["messages"][0]["text"], "second");
        assert!(read("nothing like it".into()).is_err());
        // Its own conversation is not one of the others.
        assert!(read(me.0.to_string()).is_err());
    }
}
