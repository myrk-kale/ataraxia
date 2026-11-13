//! BTW: a contextual side investigation that never disturbs the main conversation.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::actions;
use super::engine::Engine;
use crate::domain::ids::SessionId;
use crate::domain::{
    ArtifactStatus, BtwMode, BtwTask, BtwTaskId, ChatSession, Error, ErrorCode, InsightEvent,
    Result, ReturnPolicy, SessionKind,
};

const MAX_SELECTION_CHARS: usize = 8_000;
const MAX_QUESTION_CHARS: usize = 4_000;
const MAX_CONTEXT_LINES: usize = 200;
/// The other spaces' items are background, not the question: they get a smaller share.
const MAX_OTHER_LINES: usize = 80;
const MAX_OTHER_ITEMS: usize = 4;
/// How much of the main conversation a fork starts from.
const MAX_FORK_CHARS: usize = 14_000;
const MAX_FORK_MESSAGES: usize = 40;
const MAX_SUMMARY_CHARS: usize = 6_000;
const MAX_ACTIONS: usize = 20;
const MAX_QUEUE_LINES: usize = 50;
/// How much of what BTW answered goes into the note the main agent receives.
const MAX_NOTE_CHARS: usize = 1_800;
const ACTIONS_FENCE: &str = "```ataraxia-actions";

fn done_key(task: BtwTaskId) -> String {
    format!("btw_done:{}", task.0)
}

/// The answer without its action block, and the actions in it: `None` when there is no block,
/// `Err` when there is one that cannot be read.
pub fn split_actions(answer: &str) -> (String, Option<std::result::Result<Vec<Value>, String>>) {
    let Some(start) = answer.rfind(ACTIONS_FENCE) else {
        return (answer.trim().to_string(), None);
    };
    let body_start = start + ACTIONS_FENCE.len();
    let Some(close) = answer[body_start..].find("```") else {
        return (answer.trim().to_string(), None);
    };
    let body = &answer[body_start..body_start + close];
    let rest = format!("{}{}", &answer[..start], &answer[body_start + close + 3..]);
    let parsed = match serde_json::from_str::<Value>(body.trim()) {
        Ok(Value::Array(items)) => Ok(items),
        Ok(Value::Object(map)) => map
            .get("actions")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| "the block is an object without an `actions` list".to_string()),
        Ok(_) => Err("the block is not a list of actions".to_string()),
        Err(error) => Err(error.to_string()),
    };
    (rest.trim().to_string(), Some(parsed))
}

/// What the UI says the user is looking at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtwContext {
    /// `chat`, `code`, `decisions` or `flow`.
    pub space: String,
    #[serde(default)]
    pub item: Option<ContextItem>,
    /// What the other spaces have open (the file or component in Code, the decision, the diagram),
    /// so BTW knows it whichever space it was summoned from.
    #[serde(default)]
    pub active: Vec<ContextItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    /// `file`, `selection`, `decision`, `flow-node`, ...
    pub kind: String,
    pub label: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub end_line: Option<u32>,
    /// Text the user selected or the UI wants to attach.
    #[serde(default)]
    pub text: Option<String>,
}

/// Files that probably hold credentials are never attached to a question.
pub fn looks_secret(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.contains("credentials")
        || name.contains("secrets")
        || name == ".npmrc"
        || name == ".netrc"
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(max).collect();
    cut.push_str("\n… (cut)");
    cut
}

impl Engine {
    /// One open item as text: what it is, where it is, and the code or text it holds.
    fn render_item(
        &self,
        worktree: &std::path::Path,
        item: &ContextItem,
        line_budget: usize,
    ) -> String {
        let mut out = format!("{} ({})\n", item.label, item.kind);
        if let Some(path) = &item.path {
            let lines = match (item.start_line, item.end_line) {
                (Some(start), Some(end)) if end != start => format!(":{start}-{end}"),
                (Some(start), _) => format!(":{start}"),
                _ => String::new(),
            };
            out.push_str(&format!("File: {path}{lines}\n"));
            if looks_secret(path) {
                out.push_str("(contents withheld: the file looks like it holds secrets)\n");
                return out;
            }
            let body = match &item.text {
                Some(text) if !text.trim().is_empty() => Some(clip(text, MAX_SELECTION_CHARS)),
                _ => match self.fs.read_text(worktree, path) {
                    Ok(file) if !file.binary && !file.too_large => {
                        let all: Vec<&str> = file.text.lines().collect();
                        let start = item
                            .start_line
                            .map_or(0, |line| line.saturating_sub(1) as usize);
                        let end = item
                            .end_line
                            .map_or(all.len().min(start + line_budget), |line| line as usize);
                        let end = end.min(all.len()).min(start + line_budget);
                        (start < end).then(|| all[start..end].join("\n"))
                    }
                    // Paths outside the worktree, or unreadable ones, are simply not attached.
                    _ => None,
                },
            };
            if let Some(body) = body {
                out.push_str(&format!("```\n{body}\n```\n"));
            }
        } else if let Some(text) = &item.text {
            out.push_str(&format!("```\n{}\n```\n", clip(text, MAX_SELECTION_CHARS)));
        }
        out
    }

    /// The main conversation as a fork starts from it: the latest messages, oldest first, each
    /// cut to a sensible length, and the tools it used by name only.
    fn fork_transcript(&self, parent: SessionId) -> String {
        let live = self
            .runtime
            .snapshot(&parent)
            .map(|snapshot| snapshot.items)
            .unwrap_or_default();
        let items = if live.is_empty() {
            self.db.list_chat_items(parent).unwrap_or_default()
        } else {
            live
        };
        let mut lines: Vec<String> = Vec::new();
        for item in &items {
            match item {
                crate::domain::ChatItem::Message(message) if !message.text.trim().is_empty() => {
                    let who = match message.role {
                        crate::domain::ChatRole::User => "Developer",
                        crate::domain::ChatRole::Assistant => "Agent",
                        crate::domain::ChatRole::System => continue,
                    };
                    lines.push(format!("{who}: {}", clip(message.text.trim(), 2_500)));
                }
                crate::domain::ChatItem::Tool(tool) => {
                    lines.push(format!("(Agent used {})", tool.name))
                }
                _ => {}
            }
        }
        let skip = lines.len().saturating_sub(MAX_FORK_MESSAGES);
        let mut kept: Vec<&String> = Vec::new();
        let mut size = 0;
        for line in lines[skip..].iter().rev() {
            size += line.chars().count();
            if size > MAX_FORK_CHARS {
                break;
            }
            kept.push(line);
        }
        kept.reverse();
        if kept.is_empty() {
            return String::new();
        }
        let earlier = lines.len() - kept.len();
        let mut out = String::from("Conversation so far (the chat you are a fork of):\n");
        if earlier > 0 {
            out.push_str(&format!("({earlier} earlier items left out)\n"));
        }
        for line in kept {
            out.push_str(line);
            out.push('\n');
        }
        out
    }

    /// The exact text that will be attached to the question, so the user can inspect it.
    pub fn btw_render_context(
        &self,
        session_id: SessionId,
        context: &BtwContext,
    ) -> Result<String> {
        let session = self.session(session_id)?;
        let repository = self
            .db
            .get_repository(session.repository_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "repository not found"))?;
        let worktree = self
            .db
            .get_worktree(session.worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?;
        let mut out = format!(
            "Repository: {}\nBranch: {}\nChat: {}\nSpace: {}\n",
            repository.name,
            worktree.branch.as_deref().unwrap_or("(detached)"),
            session.title,
            context.space
        );
        if let Some(item) = &context.item {
            out.push_str("Looking at: ");
            out.push_str(&self.render_item(&worktree.path, item, MAX_CONTEXT_LINES));
        }
        let others: Vec<&ContextItem> = context.active.iter().take(MAX_OTHER_ITEMS).collect();
        if !others.is_empty() {
            out.push_str("\nAlso open in Ataraxia right now:\n");
            for item in others {
                out.push_str("- ");
                out.push_str(&self.render_item(&worktree.path, item, MAX_OTHER_LINES));
            }
        }
        if context.space == "chat" {
            out.push_str(
                "\nThis was asked from the chat itself: you are a fork of that conversation, \
                 whose history you are given below the question.\n",
            );
        }
        Ok(out)
    }

    /// Starts a BTW investigation. Questions are read-only; a delegated change needs `authorized`.
    pub fn btw_start(
        &self,
        parent_session_id: SessionId,
        mode: BtwMode,
        question: &str,
        context: &BtwContext,
        policy: ReturnPolicy,
        authorized: bool,
    ) -> Result<BtwTask> {
        self.btw_start_with(
            parent_session_id,
            mode,
            question,
            context,
            policy,
            authorized,
            None,
            None,
        )
    }

    /// Like [`Self::btw_start`], on the provider and model the person chose (the chat's own when
    /// none).
    #[allow(clippy::too_many_arguments)]
    pub fn btw_start_with(
        &self,
        parent_session_id: SessionId,
        mode: BtwMode,
        question: &str,
        context: &BtwContext,
        policy: ReturnPolicy,
        authorized: bool,
        provider: Option<crate::domain::agent::ProviderKind>,
        model: Option<String>,
    ) -> Result<BtwTask> {
        let question = question.trim();
        if question.is_empty() {
            return Err(Error::new(ErrorCode::Invalid, "ask something first"));
        }
        if question.chars().count() > MAX_QUESTION_CHARS {
            return Err(Error::new(ErrorCode::Invalid, "the question is too long"));
        }
        if mode == BtwMode::Change && !authorized {
            return Err(Error::new(
                ErrorCode::Invalid,
                "a delegated change needs your explicit authorization",
            ));
        }
        let parent = self.session(parent_session_id)?;
        if parent.kind != SessionKind::Chat {
            return Err(Error::new(ErrorCode::Invalid, "BTW attaches to a chat"));
        }
        // The main agent is always told when BTW is done, so it never works unaware of what was
        // asked, answered or changed beside it. The policy argument is kept for older callers.
        let _ = policy;
        let policy = ReturnPolicy::OnCompletion;
        let context_text = self.btw_render_context(parent_session_id, context)?;
        let hidden = self.hidden_session_with(
            &parent,
            if mode == BtwMode::Ask {
                SessionKind::Btw
            } else {
                SessionKind::Delegate
            },
            &format!("BTW: {}", clip(question, 48)),
            provider,
            model.filter(|model| !model.trim().is_empty()),
        )?;
        let now = self.now();
        let task = BtwTask {
            id: BtwTaskId::new(),
            parent_session_id,
            session_id: hidden.id,
            mode,
            question: question.to_string(),
            context: serde_json::to_value(context).unwrap_or(Value::Null),
            context_text: context_text.clone(),
            return_policy: policy,
            summary: None,
            returned_at: None,
            status: ArtifactStatus::Running,
            created_at: now.clone(),
            updated_at: now,
        };
        self.db.insert_btw_task(&task)?;
        let framing = match mode {
            BtwMode::Ask => {
                "You are BTW, a quick side investigation next to the developer's main agent. \
                 This is READ-ONLY: look at the code and answer, but never modify files or run \
                 anything that writes. Be concise."
            }
            BtwMode::Change => {
                "You are BTW, handling a task the developer delegated explicitly. You may edit \
                 files in this worktree. Finish with a short summary of what you changed."
            }
        };
        let brief = self.btw_actions_brief(&parent);
        // From the chat it is a fork: it starts from what the main conversation has said so far.
        let fork = if context.space == "chat" {
            self.fork_transcript(parent_session_id)
        } else {
            String::new()
        };
        let fork = if fork.is_empty() {
            fork
        } else {
            format!("\n{fork}")
        };
        let prompt = format!(
            "{framing}\n\n{brief}\nContext:\n{context_text}\nQuestion:\n{question}\n{fork}"
        );
        self.runtime.start_session(&hidden)?;
        // It is one of the chat's subagents from the start: listed there, with its own conversation.
        if let Err(error) =
            self.runtime
                .link_subagent(&hidden.id, &parent_session_id, &hidden.title, question)
        {
            eprintln!("ataraxia: could not list BTW among the subagents: {error}");
        }
        if mode == BtwMode::Change {
            self.turn_started(hidden.id);
        }
        if let Err(error) = self.runtime.prompt(&hidden.id, &prompt) {
            let _ = self.db.update_btw_task(
                task.id,
                ArtifactStatus::Failed,
                Some(&error.message),
                None,
                &self.now(),
            );
            return Err(error);
        }
        self.sink.emit_insight(InsightEvent::Btw {
            task_id: task.id,
            parent_session_id,
            status: ArtifactStatus::Running,
        });
        Ok(task)
    }

    pub fn btw_tasks(&self, parent: SessionId) -> Result<Vec<BtwTask>> {
        self.db.list_btw_tasks(parent)
    }

    pub fn btw_session(&self, task_id: BtwTaskId) -> Result<ChatSession> {
        let task = self
            .db
            .get_btw_task(task_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "BTW task not found"))?;
        self.session(task.session_id)
    }

    /// What BTW is told it can do inside Ataraxia, and the names it may use: the review queue of
    /// the newest checkpoint and the diagram presets. Only on request, never on its own.
    fn btw_actions_brief(&self, parent: &ChatSession) -> String {
        let mut brief = String::from(
            "You can also do things inside Ataraxia, but ONLY when the developer asks for one of \
             them in this conversation, never on your own initiative. To do them, end your answer \
             with ONE fenced block, with nothing after it:\n\
             ```ataraxia-actions\n\
             [{\"type\":\"comment\",\"path\":\"src/a.py\",\"unit\":\"Repo.create\",\"text\":\"...\"}]\n\
             ```\n\
             Actions:\n\
             - comment: leave a review comment on a component of the review queue: \
             {\"type\":\"comment\",\"path\":\"file\",\"unit\":\"name\",\"text\":\"...\"} \
             (or \"line\":12 instead of \"unit\").\n\
             - priority: set where a component sits in the queue, 0 to 100 (45 or more is High, 20 \
             or more Medium): {\"type\":\"priority\",\"path\":\"file\",\"unit\":\"name\",\
             \"score\":85,\"reason\":\"why\"}; to put it back: {\"type\":\"priority\",\"path\":\"file\",\
             \"unit\":\"name\",\"reset\":true}.\n\
             - generate_decisions: {\"type\":\"generate_decisions\",\"focus\":\"optional\"} opens decision \
             threads for the latest changes.\n\
             - generate_flow: {\"type\":\"generate_flow\",\"preset\":\"name\",\"focus\":\"optional\"} draws a \
             diagram.\n\
             Use component names and files exactly as listed below, and say in your answer what \
             you are doing.\n",
        );
        if let Ok(presets) = self.flow_presets(parent.repository_id) {
            let names: Vec<String> = presets.into_iter().map(|preset| preset.name).collect();
            brief.push_str(&format!("Diagram presets: {}.\n", names.join(", ")));
        }
        match self.db.latest_checkpoint(parent.id) {
            Ok(Some(checkpoint)) => {
                let priority = self.shown_priority(&checkpoint);
                brief.push_str(&format!(
                    "Review queue of checkpoint #{} (score | component | file:lines):\n",
                    checkpoint.seq
                ));
                for unit in priority.units.iter().take(MAX_QUEUE_LINES) {
                    brief.push_str(&format!(
                        "- {} | {} | {}:{}-{}\n",
                        unit.score, unit.name, unit.path, unit.start_line, unit.end_line
                    ));
                }
            }
            _ => brief.push_str("The chat has no checkpoint yet, so there is no review queue.\n"),
        }
        brief
    }

    /// Does what BTW asked to be done, one result line per action. Each line says what happened
    /// or why it could not.
    fn apply_btw_actions(self: &Arc<Self>, parent: &ChatSession, actions: &[Value]) -> Vec<String> {
        let mut lines = Vec::new();
        let Ok(Some(checkpoint)) = self.db.latest_checkpoint(parent.id) else {
            return vec!["Could not act: the chat has no checkpoint yet".into()];
        };
        let priority = self.computed_priority(&checkpoint);
        let now = self.now();
        let mut touched_review = false;
        for action in actions.iter().take(MAX_ACTIONS) {
            let kind = actions::text_of(action, "type");
            let result = match kind.as_str() {
                "comment" => actions::comment_on_unit(
                    self.db.as_ref(),
                    Some(&priority),
                    checkpoint.id,
                    &actions::text_of(action, "path"),
                    Some(actions::text_of(action, "unit").as_str()),
                    action
                        .get("line")
                        .and_then(Value::as_u64)
                        .and_then(|line| u32::try_from(line).ok()),
                    &actions::text_of(action, "text"),
                    "agent",
                    &now,
                )
                .inspect(|_| touched_review = true),
                "priority" => {
                    let (path, unit) = (
                        actions::text_of(action, "path"),
                        actions::text_of(action, "unit"),
                    );
                    if action.get("reset").and_then(Value::as_bool) == Some(true) {
                        actions::reset_unit_priority(
                            self.db.as_ref(),
                            &priority,
                            checkpoint.id,
                            &path,
                            &unit,
                        )
                    } else {
                        let score = action
                            .get("score")
                            .and_then(Value::as_f64)
                            .map(|n| n.round());
                        match score {
                            Some(score) if (0.0..=100.0).contains(&score) => {
                                actions::set_unit_priority(
                                    self.db.as_ref(),
                                    &priority,
                                    checkpoint.id,
                                    &path,
                                    &unit,
                                    score as u32,
                                    &actions::text_of(action, "reason"),
                                    "agent",
                                    &now,
                                )
                            }
                            _ => Err(Error::new(
                                ErrorCode::Invalid,
                                "a priority needs a `score` from 0 to 100",
                            )),
                        }
                    }
                    .inspect(|_| touched_review = true)
                }
                "generate_decisions" => {
                    let focus = actions::text_of(action, "focus");
                    self.generate_decisions_focused(
                        parent.id,
                        Some(checkpoint.id),
                        None,
                        None,
                        Some(focus.clone()),
                    )
                    .map(|_| {
                        if focus.is_empty() {
                            format!("Started generating decisions for checkpoint #{}", checkpoint.seq)
                        } else {
                            format!(
                                "Started generating decisions for checkpoint #{}, focused on: {focus}",
                                checkpoint.seq
                            )
                        }
                    })
                }
                "generate_flow" => self.btw_generate_flow(parent, action),
                other => Err(Error::new(
                    ErrorCode::Invalid,
                    format!("`{other}` is not something BTW can do here"),
                )),
            };
            lines.push(match result {
                Ok(done) => done,
                Err(error) => format!(
                    "Could not {}: {}",
                    if kind.is_empty() {
                        "act"
                    } else {
                        kind.as_str()
                    },
                    error.message
                ),
            });
        }
        if actions.len() > MAX_ACTIONS {
            lines.push(format!(
                "Ignored {} more actions: at most {MAX_ACTIONS} at a time",
                actions.len() - MAX_ACTIONS
            ));
        }
        if touched_review {
            self.sink.emit_insight(InsightEvent::Checkpoint {
                session_id: parent.id,
                checkpoint_id: checkpoint.id,
            });
        }
        lines
    }

    fn btw_generate_flow(self: &Arc<Self>, parent: &ChatSession, action: &Value) -> Result<String> {
        let wanted = actions::text_of(action, "preset").to_lowercase();
        let presets = self.flow_presets(parent.repository_id)?;
        let preset = presets
            .iter()
            .find(|preset| !wanted.is_empty() && preset.name.to_lowercase() == wanted)
            .or_else(|| {
                presets.iter().find(|preset| {
                    !wanted.is_empty() && preset.name.to_lowercase().contains(&wanted)
                })
            })
            .or_else(|| presets.first())
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "there is no diagram preset"))?;
        let focus = actions::text_of(action, "focus");
        self.flow_generate(parent.id, preset.id, &focus)?;
        Ok(if focus.is_empty() {
            format!(
                "Started drawing a diagram with the preset \"{}\"",
                preset.name
            )
        } else {
            format!(
                "Started drawing a diagram with the preset \"{}\", focused on: {focus}",
                preset.name
            )
        })
    }

    /// Called when a BTW conversation finishes a turn: reads what it answered, does what it was
    /// asked to do in Ataraxia, keeps the summary fresh and tells the main agent.
    pub(crate) fn btw_turn_finished(self: &Arc<Self>, session_id: SessionId, ok: bool) {
        let Ok(Some(task)) = self.db.btw_task_for_session(session_id) else {
            return;
        };
        let answer = self.last_answer(&session_id).unwrap_or_default();
        let (text, found) = split_actions(&answer);
        let mut done: Vec<String> = self
            .db
            .get_preference(&done_key(task.id))
            .ok()
            .flatten()
            .map(|saved| saved.lines().map(str::to_string).collect())
            .unwrap_or_default();
        if ok {
            match found {
                Some(Ok(list)) => {
                    if let Ok(parent) = self.session(task.parent_session_id) {
                        done.extend(self.apply_btw_actions(&parent, &list));
                    }
                }
                Some(Err(reason)) => {
                    done.push(format!("Could not read the actions BTW proposed: {reason}"))
                }
                None => {}
            }
            let _ = self.db.set_preference(&done_key(task.id), &done.join("\n"));
        }
        let mut summary = text.trim().to_string();
        if !done.is_empty() {
            let list: Vec<String> = done.iter().map(|line| format!("- {line}")).collect();
            summary = format!("{summary}\n\nDone in Ataraxia:\n{}", list.join("\n"))
                .trim()
                .to_string();
        }
        let summary = (!summary.is_empty()).then(|| clip(&summary, MAX_SUMMARY_CHARS));
        let status = if ok {
            ArtifactStatus::Ready
        } else {
            ArtifactStatus::Failed
        };
        let _ = self
            .db
            .update_btw_task(task.id, status, summary.as_deref(), None, &self.now());
        self.sink.emit_insight(InsightEvent::Btw {
            task_id: task.id,
            parent_session_id: task.parent_session_id,
            status,
        });
        if ok {
            self.btw_deliver(task.parent_session_id);
        }
    }

    /// Tells the main agent what BTW did, for its awareness: one note for everything that is
    /// waiting, sent now if the main agent is free and as soon as its turn ends if it is not. A
    /// note that cannot be sent stays pending, so nothing is lost.
    pub(crate) fn btw_deliver(&self, parent: SessionId) {
        let key = format!("btw-deliver:{}", parent.0);
        if !self.busy.lock().insert(key.clone()) {
            // Another delivery is under way; whatever it misses goes with the next turn's end.
            return;
        }
        let outcome = self.btw_deliver_pending(parent);
        self.busy.lock().remove(&key);
        if let Err(error) = outcome {
            eprintln!("ataraxia: could not tell the main agent about BTW: {error}");
        }
    }

    fn btw_deliver_pending(&self, parent: SessionId) -> Result<()> {
        let pending: Vec<BtwTask> = self
            .db
            .list_btw_tasks(parent)?
            .into_iter()
            .filter(|task| {
                task.status == ArtifactStatus::Ready
                    && task
                        .summary
                        .as_deref()
                        .is_some_and(|text| !text.trim().is_empty())
                    && task
                        .returned_at
                        .as_deref()
                        .is_none_or(|sent| sent < task.updated_at.as_str())
            })
            .collect();
        if pending.is_empty() {
            return Ok(());
        }
        let note = awareness_note(&pending);
        let session = self.session(parent)?;
        for attempt in 0..6 {
            let sent = (|| -> Result<()> {
                self.runtime.start_session(&session)?;
                self.turn_started(session.id);
                self.runtime.prompt(&session.id, &note).map(|_| ())
            })();
            match sent {
                Ok(()) => {
                    let now = self.now();
                    for task in &pending {
                        self.db
                            .update_btw_task(task.id, task.status, None, Some(&now), &now)?;
                        self.sink.emit_insight(InsightEvent::Btw {
                            task_id: task.id,
                            parent_session_id: parent,
                            status: task.status,
                        });
                    }
                    return Ok(());
                }
                // The main agent is mid-turn: wait a moment, and if it is still busy the note is
                // sent when that turn ends.
                Err(error) if error.message.contains("already running") && attempt < 5 => {
                    std::thread::sleep(Duration::from_millis(400));
                }
                Err(error) if error.message.contains("already running") => return Ok(()),
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    /// Sends the result of a BTW investigation to the main agent right now.
    pub fn btw_return(&self, task_id: BtwTaskId) -> Result<()> {
        let task = self
            .db
            .get_btw_task(task_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "BTW task not found"))?;
        if task
            .summary
            .as_deref()
            .is_none_or(|text| text.trim().is_empty())
        {
            return Err(Error::new(
                ErrorCode::Invalid,
                "there is no result to send yet",
            ));
        }
        let parent = self.session(task.parent_session_id)?;
        self.runtime.start_session(&parent)?;
        self.turn_started(parent.id);
        self.runtime
            .prompt(&parent.id, &awareness_note(std::slice::from_ref(&task)))?;
        let now = self.now();
        self.db
            .update_btw_task(task.id, task.status, None, Some(&now), &now)?;
        self.sink.emit_insight(InsightEvent::Btw {
            task_id: task.id,
            parent_session_id: task.parent_session_id,
            status: task.status,
        });
        Ok(())
    }

    /// The structured form of a task for the UI.
    pub fn btw_task(&self, task_id: BtwTaskId) -> Result<Value> {
        let task = self
            .db
            .get_btw_task(task_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "BTW task not found"))?;
        Ok(json!(task))
    }
}

/// The note the main agent receives: what was asked beside it and what BTW did, for awareness.
pub fn awareness_note(tasks: &[BtwTask]) -> String {
    let mut note = String::from(
        "[BTW report, for your awareness. This is not a request: answer in one short sentence at \
         most, and do not start new work unless the developer asks.]\n\
         The developer used BTW, a side conversation that does not appear in this chat, and it \
         finished.\n",
    );
    for (index, task) in tasks.iter().enumerate() {
        let mode = match task.mode {
            BtwMode::Ask => "a read-only question",
            BtwMode::Change => "a delegated change, which may have edited files in this worktree",
        };
        note.push_str(&format!(
            "\n{}. Asked ({mode}): {}\n{}\n",
            index + 1,
            task.question,
            clip(
                task.summary.as_deref().unwrap_or_default().trim(),
                MAX_NOTE_CHARS
            )
        ));
    }
    note
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_looking_files_are_recognised() {
        for path in [
            ".env",
            "config/.env.production",
            "keys/server.pem",
            "ssh/id_rsa",
            "aws/credentials.json",
            ".npmrc",
        ] {
            assert!(looks_secret(path), "{path}");
        }
        for path in ["src/environment.ts", "README.md", "src/keyboard.rs"] {
            assert!(!looks_secret(path), "{path}");
        }
    }

    #[test]
    fn clip_marks_what_it_cuts() {
        assert_eq!(clip("short", 10), "short");
        assert!(clip(&"x".repeat(50), 10).ends_with("(cut)"));
    }
}
