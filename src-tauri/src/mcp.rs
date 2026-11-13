//! A small MCP server (stdio, JSON-RPC) that lets an agent read and update Ataraxia's artifacts.
//!
//! Scope: with `--session`, only that chat's data is visible. Authorization: reads are always
//! allowed, writes only with `--allow-write`. Audit: every call lands in `mcp_audit`.

use std::io::{BufRead, Write};
use std::sync::Arc;

use serde_json::{Value, json};
use uuid::Uuid;

use crate::domain::ids::{CheckpointId, SessionId};
use crate::domain::time::now_rfc3339;
use crate::domain::{
    ArtifactId, ArtifactKind, CodeRef, Decision, DecisionId, DecisionKind, DecisionMessage,
    DecisionState, Error, ErrorCode, Result,
};
use crate::ports::{Database, Git};

pub struct McpServer {
    db: Arc<dyn Database>,
    scope: Option<SessionId>,
    allow_write: bool,
}

const PROTOCOL: &str = "2024-11-05";

fn tools() -> Value {
    let id = |description: &str| json!({ "type": "string", "description": description });
    json!([
        {
            "name": "ataraxia_list_artifacts",
            "description": "List the artifacts (decisions run, review priority, flows) of a chat session.",
            "inputSchema": { "type": "object", "properties": {
                "session_id": id("Chat session id (optional when the server is scoped)"),
                "kind": { "type": "string", "enum": ["decision", "review_priority", "flow"] } } }
        },
        {
            "name": "ataraxia_get_artifact",
            "description": "Read one artifact with its content and provenance.",
            "inputSchema": { "type": "object", "required": ["artifact_id"],
                "properties": { "artifact_id": id("Artifact id") } }
        },
        {
            "name": "ataraxia_list_decisions",
            "description": "List the engineering decisions of a chat session.",
            "inputSchema": { "type": "object", "properties": {
                "session_id": id("Chat session id (optional when the server is scoped)") } }
        },
        {
            "name": "ataraxia_get_decision",
            "description": "Read a decision with its discussion.",
            "inputSchema": { "type": "object", "required": ["decision_id"],
                "properties": { "decision_id": id("Decision id") } }
        },
        {
            "name": "ataraxia_record_decision",
            "description": "Open an engineering decision as a thread in the Decisions tab (needs write access). Call it once per decision when the user asks you to generate, record or write down the decisions of this work. A decision is a choice the reviewer should consciously accept or reject. Threads stay open while the code changes.",
            "inputSchema": { "type": "object", "required": ["title", "summary"],
                "properties": {
                    "checkpoint_id": id("Checkpoint it arose from (optional: the newest of this chat)"),
                    "type": { "type": "string", "enum": ["api-contract", "data-integrity", "behavior", "security", "dependencies", "performance", "code-organization", "ux", "other"] },
                    "title": { "type": "string" },
                    "summary": { "type": "string" }, "context": { "type": "string" },
                    "rationale": { "type": "string" },
                    "files": { "type": "array", "description": "Code the decision is about",
                        "items": { "type": "object", "required": ["path"], "properties": {
                            "path": { "type": "string" }, "start_line": { "type": "integer" },
                            "end_line": { "type": "integer" } } } } } }
        },
        {
            "name": "ataraxia_comment_unit",
            "description": "Leave a review comment on a component (function, method, type) of the review queue, or on a line of a file (needs write access). Use it only when the user asks you to comment on code in the review; the comment is marked as yours.",
            "inputSchema": { "type": "object", "required": ["text"],
                "properties": {
                    "path": { "type": "string", "description": "File, as the review queue lists it" },
                    "unit": { "type": "string", "description": "Component name, as the review queue lists it (omit to comment on a line)" },
                    "line": { "type": "integer" },
                    "text": { "type": "string" },
                    "checkpoint_id": id("Checkpoint (optional: the newest of this chat)") } }
        },
        {
            "name": "ataraxia_set_priority",
            "description": "Change where a component sits in the review queue, 0 to 100 (45 or more is High, 20 or more Medium), or put it back with reset (needs write access). Use it only when the user asks you to re-prioritise; always give the reason.",
            "inputSchema": { "type": "object", "required": ["path", "unit"],
                "properties": {
                    "path": { "type": "string" }, "unit": { "type": "string" },
                    "score": { "type": "integer" }, "reason": { "type": "string" },
                    "reset": { "type": "boolean", "description": "Restore the computed priority" },
                    "checkpoint_id": id("Checkpoint (optional: the newest of this chat)") } }
        },
        {
            "name": "ataraxia_record_flow",
            "description": "Draw a diagram of how the code works in the Flow tab (needs write access). Use it when the user asks you to generate a flow. Ground every node in files that exist; nodes referring to files that do not exist are marked unverified.",
            "inputSchema": { "type": "object", "required": ["nodes"],
                "properties": {
                    "name": { "type": "string", "description": "What the diagram shows, in a few words" },
                    "summary": { "type": "string" },
                    "nodes": { "type": "array", "items": { "type": "object", "required": ["id", "label"], "properties": {
                        "id": { "type": "string" }, "label": { "type": "string" },
                        "kind": { "type": "string", "enum": ["entry", "component", "function", "data", "external", "step"] },
                        "description": { "type": "string" },
                        "refs": { "type": "array", "items": { "type": "object", "properties": { "path": { "type": "string" }, "line": { "type": "integer" } } } } } } },
                    "edges": { "type": "array", "items": { "type": "object", "required": ["source", "target"], "properties": {
                        "source": { "type": "string" }, "target": { "type": "string" }, "label": { "type": "string" } } } } } }
        },
        {
            "name": "ataraxia_link_commit",
            "description": "Say that a commit influences a decision, with a note on how (needs write access). Use it after committing work that settles, changes or contradicts a decision.",
            "inputSchema": { "type": "object", "required": ["decision_id", "commit"],
                "properties": { "decision_id": id("Decision id"),
                    "commit": id("Commit id, short id, branch or tag"),
                    "note": { "type": "string", "description": "What the commit did to the decision" } } }
        },
        {
            "name": "ataraxia_add_decision_message",
            "description": "Add a message to a decision's discussion (needs write access).",
            "inputSchema": { "type": "object", "required": ["decision_id", "text"],
                "properties": { "decision_id": id("Decision id"), "text": { "type": "string" } } }
        }
    ])
}

fn arg_uuid(args: &Value, key: &str) -> Result<Uuid> {
    args.get(key)
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| Error::new(ErrorCode::Invalid, format!("`{key}` must be a UUID")))
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

impl McpServer {
    pub fn new(db: Arc<dyn Database>, scope: Option<SessionId>, allow_write: bool) -> Self {
        Self {
            db,
            scope,
            allow_write,
        }
    }

    fn session_arg(&self, args: &Value) -> Result<SessionId> {
        let requested = args
            .get("session_id")
            .and_then(Value::as_str)
            .and_then(|value| Uuid::parse_str(value).ok())
            .map(SessionId);
        match (self.scope, requested) {
            (Some(scope), Some(requested)) if scope != requested => Err(Error::new(
                ErrorCode::Invalid,
                "that session is outside this server's scope",
            )),
            (Some(scope), _) => Ok(scope),
            (None, Some(requested)) => Ok(requested),
            (None, None) => Err(Error::new(ErrorCode::Invalid, "`session_id` is required")),
        }
    }

    /// The chat and the checkpoint a call is about: the one named, or the chat's newest.
    fn checkpoint_arg(&self, args: &Value) -> Result<(SessionId, crate::domain::Checkpoint)> {
        let checkpoint = match args.get("checkpoint_id").and_then(Value::as_str) {
            Some(_) => self
                .db
                .get_checkpoint(CheckpointId(arg_uuid(args, "checkpoint_id")?))?
                .ok_or_else(|| Error::new(ErrorCode::NotFound, "checkpoint not found"))?,
            None => {
                let session = self.session_arg(args)?;
                self.db.latest_checkpoint(session)?.ok_or_else(|| {
                    Error::new(
                        ErrorCode::Invalid,
                        "nothing has changed in this chat yet, so there is nothing to review",
                    )
                })?
            }
        };
        self.in_scope(checkpoint.session_id)?;
        Ok((checkpoint.session_id, checkpoint))
    }

    fn in_scope(&self, session_id: SessionId) -> Result<()> {
        match self.scope {
            Some(scope) if scope != session_id => Err(Error::new(
                ErrorCode::Invalid,
                "that item is outside this server's scope",
            )),
            _ => Ok(()),
        }
    }

    fn require_write(&self) -> Result<()> {
        if self.allow_write {
            Ok(())
        } else {
            Err(Error::new(
                ErrorCode::Invalid,
                "this server is read-only; start it with --allow-write to update artifacts",
            ))
        }
    }

    fn call_tool(&self, name: &str, args: &Value) -> Result<(Value, bool)> {
        let now = now_rfc3339()?;
        match name {
            "ataraxia_list_artifacts" => {
                let session = self.session_arg(args)?;
                let kind = args
                    .get("kind")
                    .and_then(Value::as_str)
                    .and_then(ArtifactKind::parse);
                Ok((json!(self.db.list_artifacts(session, kind)?), false))
            }
            "ataraxia_get_artifact" => {
                let artifact = self
                    .db
                    .get_artifact(ArtifactId(arg_uuid(args, "artifact_id")?))?
                    .ok_or_else(|| Error::new(ErrorCode::NotFound, "artifact not found"))?;
                self.in_scope(artifact.session_id)?;
                Ok((json!(artifact), false))
            }
            "ataraxia_list_decisions" => {
                let session = self.session_arg(args)?;
                Ok((json!(self.db.list_decisions(session)?), false))
            }
            "ataraxia_get_decision" => {
                let id = DecisionId(arg_uuid(args, "decision_id")?);
                let decision = self
                    .db
                    .get_decision(id)?
                    .ok_or_else(|| Error::new(ErrorCode::NotFound, "decision not found"))?;
                self.in_scope(decision.session_id)?;
                Ok((
                    json!({ "decision": decision, "messages": self.db.list_decision_messages(id)? }),
                    false,
                ))
            }
            "ataraxia_record_decision" => {
                self.require_write()?;
                let session = self.session_arg(args)?;
                let checkpoint = match args.get("checkpoint_id").and_then(Value::as_str) {
                    Some(_) => self
                        .db
                        .get_checkpoint(CheckpointId(arg_uuid(args, "checkpoint_id")?))?
                        .ok_or_else(|| Error::new(ErrorCode::NotFound, "checkpoint not found"))?,
                    None => self.db.latest_checkpoint(session)?.ok_or_else(|| {
                        Error::new(
                            ErrorCode::Invalid,
                            "nothing has changed in this chat yet, so there is nothing to decide about",
                        )
                    })?,
                };
                self.in_scope(checkpoint.session_id)?;
                let (title, summary) = (arg_str(args, "title"), arg_str(args, "summary"));
                if title.is_empty() || summary.is_empty() {
                    return Err(Error::new(
                        ErrorCode::Invalid,
                        "title and summary are required",
                    ));
                }
                let seq = self
                    .db
                    .list_decisions(checkpoint.session_id)?
                    .iter()
                    .map(|decision| decision.seq)
                    .max()
                    .unwrap_or(0)
                    + 1;
                let refs: Vec<CodeRef> = args
                    .get("files")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| {
                                let path = item.get("path").and_then(Value::as_str)?.to_string();
                                let line = |key: &str| {
                                    item.get(key)
                                        .and_then(Value::as_u64)
                                        .and_then(|n| u32::try_from(n).ok())
                                };
                                Some(CodeRef {
                                    path,
                                    start_line: line("start_line"),
                                    end_line: line("end_line").or(line("start_line")),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let decision = Decision {
                    id: DecisionId::new(),
                    session_id: checkpoint.session_id,
                    checkpoint_id: checkpoint.id,
                    artifact_id: None,
                    seq,
                    kind: DecisionKind::parse_lenient(&arg_str(args, "type")),
                    title,
                    summary,
                    context: arg_str(args, "context"),
                    rationale: arg_str(args, "rationale"),
                    alternatives: Vec::new(),
                    refs,
                    state: DecisionState::Pending,
                    version: 1,
                    superseded_by: None,
                    opened_by: "agent".into(),
                    created_at: now.clone(),
                    updated_at: now,
                };
                self.db.insert_decision(&decision)?;
                Ok((json!(decision), true))
            }
            "ataraxia_comment_unit" => {
                self.require_write()?;
                let (session, checkpoint) = self.checkpoint_arg(args)?;
                let priority = crate::app::actions::stored_priority(
                    self.db.as_ref(),
                    checkpoint.id,
                    session,
                    crate::app::engine::PRIORITY_VERSION,
                )?;
                let unit = crate::app::actions::text_of(args, "unit");
                let line = args
                    .get("line")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok());
                let done = crate::app::actions::comment_on_unit(
                    self.db.as_ref(),
                    priority.as_ref(),
                    checkpoint.id,
                    &crate::app::actions::text_of(args, "path"),
                    Some(unit.as_str()),
                    line,
                    &arg_str(args, "text"),
                    "agent",
                    &now,
                )?;
                Ok((json!({ "done": done }), true))
            }
            "ataraxia_set_priority" => {
                self.require_write()?;
                let (session, checkpoint) = self.checkpoint_arg(args)?;
                let priority = crate::app::actions::stored_priority(
                    self.db.as_ref(),
                    checkpoint.id,
                    session,
                    crate::app::engine::PRIORITY_VERSION,
                )?
                .ok_or_else(|| {
                    Error::new(
                        ErrorCode::NotFound,
                        "this checkpoint has no review queue yet",
                    )
                })?;
                let (path, unit) = (arg_str(args, "path"), arg_str(args, "unit"));
                let done = if args.get("reset").and_then(Value::as_bool) == Some(true) {
                    crate::app::actions::reset_unit_priority(
                        self.db.as_ref(),
                        &priority,
                        checkpoint.id,
                        &path,
                        &unit,
                    )?
                } else {
                    let score = args
                        .get("score")
                        .and_then(Value::as_f64)
                        .filter(|score| (0.0..=100.0).contains(score))
                        .ok_or_else(|| {
                            Error::new(ErrorCode::Invalid, "`score` must be a number from 0 to 100")
                        })?;
                    crate::app::actions::set_unit_priority(
                        self.db.as_ref(),
                        &priority,
                        checkpoint.id,
                        &path,
                        &unit,
                        score.round() as u32,
                        &arg_str(args, "reason"),
                        "agent",
                        &now,
                    )?
                };
                Ok((json!({ "done": done }), true))
            }
            "ataraxia_record_flow" => {
                self.require_write()?;
                let (session, checkpoint) = self.checkpoint_arg(args)?;
                let chat = self
                    .db
                    .get_session(session)?
                    .ok_or_else(|| Error::new(ErrorCode::NotFound, "session not found"))?;
                let worktree = self
                    .db
                    .get_worktree(chat.worktree_id)?
                    .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?;
                let known: std::collections::HashSet<String> = crate::adapters::git::GitCli
                    .list_files(&worktree.path)?
                    .into_iter()
                    .collect();
                let graph = crate::app::analysis::parse_flow(&args.to_string(), &known)?;
                if graph.nodes.is_empty() {
                    return Err(Error::new(
                        ErrorCode::Invalid,
                        "a diagram needs at least one node",
                    ));
                }
                let mut content = json!(graph);
                content["generatedAt"] = json!(now.clone());
                let name = arg_str(args, "name");
                let version = self
                    .db
                    .list_artifacts(session, Some(ArtifactKind::Flow))?
                    .len() as u32
                    + 1;
                let artifact = crate::domain::Artifact {
                    id: ArtifactId::new(),
                    session_id: session,
                    checkpoint_id: checkpoint.id,
                    kind: ArtifactKind::Flow,
                    dedupe_key: Uuid::new_v4().to_string(),
                    version,
                    status: crate::domain::ArtifactStatus::Ready,
                    content,
                    provenance: json!({
                        "generator": "agent-chat",
                        "presetName": if name.is_empty() { "Requested in the chat".to_string() } else { name },
                        "prompt": "",
                        "extra": "",
                        "provider": chat.provider.as_str(),
                        "headRev": checkpoint.head_rev,
                    }),
                    error: None,
                    created_at: now.clone(),
                    updated_at: now,
                };
                let (stored, _) = self.db.ensure_artifact(&artifact)?;
                Ok((
                    json!({ "done": format!("Drew a diagram with {} nodes", graph.nodes.len()), "artifact_id": stored.id.0.to_string() }),
                    true,
                ))
            }
            "ataraxia_link_commit" => {
                self.require_write()?;
                let id = DecisionId(arg_uuid(args, "decision_id")?);
                let decision = self
                    .db
                    .get_decision(id)?
                    .ok_or_else(|| Error::new(ErrorCode::NotFound, "decision not found"))?;
                self.in_scope(decision.session_id)?;
                let commit = arg_str(args, "commit");
                if commit.is_empty() {
                    return Err(Error::new(ErrorCode::Invalid, "`commit` is required"));
                }
                let session = self
                    .db
                    .get_session(decision.session_id)?
                    .ok_or_else(|| Error::new(ErrorCode::NotFound, "session not found"))?;
                let worktree = self
                    .db
                    .get_worktree(session.worktree_id)?
                    .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?;
                let info = crate::adapters::git::GitCli.commit_info(&worktree.path, &commit)?;
                let linked = crate::domain::DecisionCommit {
                    decision_id: id,
                    rev: info.rev,
                    short: info.short,
                    subject: info.subject,
                    author: info.author,
                    committed_at: info.date,
                    note: arg_str(args, "note"),
                    linked_by: "agent".into(),
                    created_at: now,
                };
                self.db.add_decision_commit(&linked)?;
                Ok((json!(linked), true))
            }
            "ataraxia_add_decision_message" => {
                self.require_write()?;
                let id = DecisionId(arg_uuid(args, "decision_id")?);
                let decision = self
                    .db
                    .get_decision(id)?
                    .ok_or_else(|| Error::new(ErrorCode::NotFound, "decision not found"))?;
                self.in_scope(decision.session_id)?;
                let text = arg_str(args, "text");
                if text.is_empty() {
                    return Err(Error::new(ErrorCode::Invalid, "`text` is required"));
                }
                let message = DecisionMessage {
                    id: Uuid::new_v4().to_string(),
                    decision_id: id,
                    author: "agent".into(),
                    text,
                    code_ref: None,
                    created_at: now,
                };
                self.db.add_decision_message(&message)?;
                Ok((json!(message), true))
            }
            other => Err(Error::new(
                ErrorCode::NotFound,
                format!("unknown tool {other}"),
            )),
        }
    }

    /// Handles one JSON-RPC message; `None` for notifications.
    pub fn handle(&self, message: &Value) -> Option<Value> {
        let id = message.get("id").cloned()?;
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let result = match method {
            "initialize" => json!({
                "protocolVersion": PROTOCOL,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "ataraxia", "version": env!("CARGO_PKG_VERSION") }
            }),
            "ping" => json!({}),
            "tools/list" => json!({ "tools": tools() }),
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let outcome = self.call_tool(name, &args);
                let (text, is_error, write) = match &outcome {
                    Ok((value, write)) => (value.to_string(), false, *write),
                    Err(error) => (error.message.clone(), true, false),
                };
                let _ = self.db.audit_mcp(
                    &now_rfc3339().unwrap_or_default(),
                    name,
                    self.scope.map(|scope| scope.0.to_string()).as_deref(),
                    write,
                    !is_error,
                    &text.chars().take(300).collect::<String>(),
                );
                json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
            }
            other => {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("method not found: {other}") }
                }));
            }
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }

    pub fn serve(&self, input: impl BufRead, mut output: impl Write) -> std::io::Result<()> {
        for line in input.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(response) = self.handle(&message) {
                writeln!(output, "{response}")?;
                output.flush()?;
            }
        }
        Ok(())
    }
}

/// `ataraxia mcp --db PATH [--session ID] [--allow-write]`
pub fn run_cli(args: &[String]) -> std::result::Result<(), String> {
    let mut db_path = None;
    let mut scope = None;
    let mut allow_write = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--db" => db_path = iter.next().cloned(),
            "--session" => {
                scope = iter
                    .next()
                    .and_then(|value| Uuid::parse_str(value).ok())
                    .map(SessionId);
                if scope.is_none() {
                    return Err("--session needs a UUID".into());
                }
            }
            "--allow-write" => allow_write = true,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let db_path = db_path.ok_or("--db is required")?;
    let store = crate::adapters::sqlite::SqliteStore::open(db_path).map_err(|e| e.to_string())?;
    let server = McpServer::new(Arc::new(store), scope, allow_write);
    server
        .serve(std::io::stdin().lock(), std::io::stdout().lock())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::sqlite::SqliteStore;
    use crate::domain::agent::ProviderKind;
    use crate::domain::ids::{RepositoryId, WorktreeId};
    use crate::domain::{
        ArtifactStatus, ChatSession, Checkpoint, CheckpointSource, Repository, SessionKind,
        SessionStatus, Worktree,
    };
    use crate::ports::InsightStore;
    use crate::ports::Store;

    fn seeded() -> (Arc<SqliteStore>, SessionId, SessionId, CheckpointId) {
        seeded_at("/r".into())
    }

    fn seeded_at(
        path: std::path::PathBuf,
    ) -> (Arc<SqliteStore>, SessionId, SessionId, CheckpointId) {
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
        let wt = Worktree {
            id: WorktreeId::new(),
            repository_id: repo.id,
            path,
            branch: None,
            head: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        db.upsert_worktree(&wt).unwrap();
        let mk = |title: &str| ChatSession {
            id: SessionId::new(),
            repository_id: repo.id,
            worktree_id: wt.id,
            provider: ProviderKind::Fake,
            title: title.into(),
            status: SessionStatus::Idle,
            model: None,
            effort: None,
            agent: None,
            kind: SessionKind::Chat,
            parent_session_id: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_opened_at: None,
        };
        let (a, b) = (mk("a"), mk("b"));
        db.create_session(&a).unwrap();
        db.create_session(&b).unwrap();
        let cp = Checkpoint {
            id: CheckpointId::new(),
            session_id: a.id,
            repository_id: repo.id,
            worktree_id: wt.id,
            seq: 1,
            base_rev: "b".into(),
            head_rev: "h".into(),
            source: CheckpointSource::Turn,
            turn_id: None,
            files: vec![],
            status: ArtifactStatus::Ready,
            created_at: now,
            base_label: None,
            head_label: None,
            head_live: true,
        };
        db.create_checkpoint(&cp).unwrap();
        (db, a.id, b.id, cp.id)
    }

    fn call(server: &McpServer, name: &str, args: Value) -> Value {
        let reply = server
            .handle(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}))
            .unwrap();
        reply["result"].clone()
    }

    #[test]
    fn speaks_the_protocol_and_lists_tools() {
        let (db, ..) = seeded();
        let server = McpServer::new(db, None, false);
        let init = server
            .handle(&json!({"jsonrpc":"2.0","id":1,"method":"initialize"}))
            .unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], "ataraxia");
        assert!(
            server
                .handle(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
                .is_none()
        );
        let list = server
            .handle(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
            .unwrap();
        assert!(list["result"]["tools"].as_array().unwrap().len() >= 6);
        let unknown = server
            .handle(&json!({"jsonrpc":"2.0","id":3,"method":"nope"}))
            .unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[test]
    fn writes_need_authorization_scope_is_enforced_and_everything_is_audited() {
        let (db, a, b, cp) = seeded();
        let read_only = McpServer::new(db.clone(), Some(a), false);
        let denied = call(
            &read_only,
            "ataraxia_record_decision",
            json!({"checkpoint_id": cp.0.to_string(), "title":"t","summary":"s"}),
        );
        assert_eq!(denied["isError"], true);
        assert!(db.list_decisions(a).unwrap().is_empty());

        let writer = McpServer::new(db.clone(), Some(a), true);
        let ok = call(
            &writer,
            "ataraxia_record_decision",
            json!({"checkpoint_id": cp.0.to_string(), "type":"security","title":"Hash it","summary":"hashed"}),
        );
        assert_eq!(ok["isError"], false);
        assert_eq!(db.list_decisions(a).unwrap().len(), 1);
        let id = db.list_decisions(a).unwrap()[0].id;
        let reply = call(
            &writer,
            "ataraxia_add_decision_message",
            json!({"decision_id": id.0.to_string(), "text":"noted"}),
        );
        assert_eq!(reply["isError"], false);
        assert_eq!(db.list_decision_messages(id).unwrap()[0].author, "agent");

        // Asked in the chat, the agent needs no checkpoint id, and says which code it is about.
        let second = call(
            &writer,
            "ataraxia_record_decision",
            json!({"title":"Keep the cache","summary":"kept","files":[{"path":"a.py","start_line":3}]}),
        );
        assert_eq!(second["isError"], false);
        let recorded = db.list_decisions(a).unwrap();
        assert_eq!(recorded[1].seq, 2);
        assert_eq!(recorded[1].opened_by, "agent");
        assert_eq!(recorded[1].checkpoint_id, cp);
        assert_eq!(recorded[1].refs[0].path, "a.py");
        assert_eq!(recorded[1].refs[0].end_line, Some(3));

        // Another chat's data is out of scope, even when asked for by id.
        let other = call(
            &writer,
            "ataraxia_list_decisions",
            json!({"session_id": b.0.to_string()}),
        );
        assert_eq!(other["isError"], true);

        assert_eq!(db.audit_count(), 5);
    }

    #[test]
    fn the_agent_links_a_commit_to_a_decision_and_a_bad_commit_is_refused() {
        let repo = std::env::temp_dir().join(format!("ataraxia-mcp-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&repo).unwrap();
        let (db, a, _, _) = seeded_at(repo.clone());
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "a@b.c"]);
        git(&["config", "user.name", "Ana"]);
        git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("a.txt"), "x").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "hash the tokens"]);
        let writer = McpServer::new(db.clone(), Some(a), true);
        call(
            &writer,
            "ataraxia_record_decision",
            json!({"title":"Hash it","summary":"hashed"}),
        );
        let id = db.list_decisions(a).unwrap()[0].id;
        let ok = call(
            &writer,
            "ataraxia_link_commit",
            json!({"decision_id": id.0.to_string(), "commit": "HEAD", "note": "Implements it"}),
        );
        assert_eq!(ok["isError"], false, "{ok}");
        let linked = db.list_decision_commits(id).unwrap();
        assert_eq!(linked.len(), 1);
        assert_eq!(linked[0].linked_by, "agent");
        assert_eq!(linked[0].subject, "hash the tokens");
        assert_eq!(linked[0].author, "Ana");
        assert_eq!(linked[0].note, "Implements it");

        let bad = call(
            &writer,
            "ataraxia_link_commit",
            json!({"decision_id": id.0.to_string(), "commit": "no-such-commit"}),
        );
        assert_eq!(bad["isError"], true);
        let read_only = McpServer::new(db.clone(), Some(a), false);
        let denied = call(
            &read_only,
            "ataraxia_link_commit",
            json!({"decision_id": id.0.to_string(), "commit": "HEAD"}),
        );
        assert_eq!(denied["isError"], true);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn in_the_chat_the_agent_comments_on_a_component_changes_its_priority_and_draws_a_flow() {
        let repo = std::env::temp_dir().join(format!("ataraxia-mcp-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "a@b.c"]);
        git(&["config", "user.name", "Ana"]);
        git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("a.py"), "def go():\n    return 1\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);
        let (db, a, _, cp) = seeded_at(repo.clone());
        let unit = |name: &str, score: u32| {
            json!({"id":"u1","name":name,"kind":"function","path":"a.py","start_line":1,"end_line":2,
                "side":"head","change":"modified","signature_changed":false,"public":true,"references":0,
                "additions":1,"deletions":0,"score":score,"level":"low","reasons":[],"container":null})
        };
        db.ensure_artifact(&crate::domain::Artifact {
            id: ArtifactId::new(),
            session_id: a,
            checkpoint_id: cp,
            kind: ArtifactKind::ReviewPriority,
            dedupe_key: String::new(),
            version: 1,
            status: crate::domain::ArtifactStatus::Ready,
            content: json!({"components":[],"files":[],"units":[unit("go", 10)],"languages":[]}),
            provenance: json!({"version": crate::app::engine::PRIORITY_VERSION}),
            error: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        })
        .unwrap();

        let writer = McpServer::new(db.clone(), Some(a), true);
        let read_only = McpServer::new(db.clone(), Some(a), false);
        let comment = json!({"path":"a.py","unit":"go","text":"Why does this return a constant?"});
        assert_eq!(
            call(&read_only, "ataraxia_comment_unit", comment.clone())["isError"],
            true
        );
        let ok = call(&writer, "ataraxia_comment_unit", comment);
        assert_eq!(ok["isError"], false, "{ok}");
        let comments = db.list_review_comments(cp).unwrap();
        assert_eq!(
            (comments[0].author.as_str(), comments[0].line),
            ("agent", Some(1))
        );
        let missing = call(
            &writer,
            "ataraxia_comment_unit",
            json!({"path":"a.py","unit":"nope","text":"x"}),
        );
        assert_eq!(missing["isError"], true);

        let set = call(
            &writer,
            "ataraxia_set_priority",
            json!({"path":"a.py","unit":"go","score":90,"reason":"public entry"}),
        );
        assert_eq!(set["isError"], false, "{set}");
        let stored = db.list_unit_priorities(cp).unwrap();
        assert_eq!((stored[0].score, stored[0].set_by.as_str()), (90, "agent"));
        let bad = call(
            &writer,
            "ataraxia_set_priority",
            json!({"path":"a.py","unit":"go","score":150}),
        );
        assert_eq!(bad["isError"], true);
        let reset = call(
            &writer,
            "ataraxia_set_priority",
            json!({"path":"a.py","unit":"go","reset":true}),
        );
        assert_eq!(reset["isError"], false);
        assert!(db.list_unit_priorities(cp).unwrap().is_empty());

        let flow = call(
            &writer,
            "ataraxia_record_flow",
            json!({"name":"Entry to storage","summary":"s","nodes":[
                {"id":"n1","label":"go","kind":"function","description":"d","refs":[{"path":"a.py","line":1}]},
                {"id":"n2","label":"store","kind":"data","description":"d","refs":[{"path":"invented.py","line":1}]}],
              "edges":[{"source":"n1","target":"n2","label":"writes"},{"source":"n1","target":"ghost","label":"x"}]}),
        );
        assert_eq!(flow["isError"], false, "{flow}");
        let flows = db.list_artifacts(a, Some(ArtifactKind::Flow)).unwrap();
        assert_eq!(flows.len(), 1);
        assert_eq!(flows[0].provenance["presetName"], "Entry to storage");
        let nodes = flows[0].content["nodes"].as_array().unwrap();
        assert_eq!(nodes[0]["verified"], true);
        assert_eq!(
            nodes[1]["verified"], false,
            "a file that does not exist is not vouched for"
        );
        assert_eq!(
            flows[0].content["edges"].as_array().unwrap().len(),
            1,
            "a dangling edge is dropped"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }
}
