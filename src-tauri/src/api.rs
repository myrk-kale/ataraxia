//! The local HTTP API: lets an agent read and update Ataraxia's artifacts with plain `curl`.
//!
//! One server runs for the whole app, on `127.0.0.1` with a port the OS picks. Every request
//! carries `Authorization: Bearer <token>`. A token is bound to one chat session (that session is
//! the scope of the call) and is read-write or read-only. The app issues one when it starts an
//! agent process and revokes it when the process goes away. Every authenticated call lands in the
//! `api_audit` table.
//!
//! The server speaks only what `curl` needs: HTTP/1.1, one request per connection, JSON in and out.

use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::domain::ids::{CheckpointId, SessionId};
use crate::domain::time::now_rfc3339;
use crate::domain::{
    ArtifactId, ArtifactKind, CodeRef, Decision, DecisionId, DecisionKind, DecisionMessage,
    DecisionState, Error, ErrorCode, Result,
};
use crate::ports::{ApiAccess, ApiGateway, Database, Git};

// ------------------------------------------------------------------ errors

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiCode {
    Invalid,
    NotFound,
    Unauthorized,
    Forbidden,
    MethodNotAllowed,
    TooLarge,
    Internal,
}

impl ApiCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::NotFound => "not_found",
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::MethodNotAllowed => "method_not_allowed",
            Self::TooLarge => "too_large",
            Self::Internal => "internal",
        }
    }

    pub fn status(self) -> u16 {
        match self {
            Self::Invalid => 400,
            Self::Unauthorized => 401,
            Self::Forbidden => 403,
            Self::NotFound => 404,
            Self::MethodNotAllowed => 405,
            Self::TooLarge => 413,
            Self::Internal => 500,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub code: ApiCode,
    pub message: String,
}

pub type ApiResult<T> = std::result::Result<T, ApiError>;

impl ApiError {
    fn new(code: ApiCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(ApiCode::Invalid, message)
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self::new(ApiCode::Forbidden, message)
    }

    fn body(&self) -> Value {
        json!({ "error": { "code": self.code.as_str(), "message": self.message } })
    }
}

impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        let code = match error.code {
            ErrorCode::NotFound => ApiCode::NotFound,
            ErrorCode::Invalid
            | ErrorCode::NotARepo
            | ErrorCode::Unsupported
            | ErrorCode::Conflict => ApiCode::Invalid,
            ErrorCode::Io | ErrorCode::Agent => ApiCode::Internal,
        };
        Self::new(code, error.message)
    }
}

// ------------------------------------------------------------------ routes

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    Index,
    ListArtifacts,
    GetArtifact,
    ListDecisions,
    GetDecision,
    RecordDecision,
    AddDecisionMessage,
    LinkCommit,
    CommentUnit,
    SetPriority,
    RecordFlow,
}

pub struct Route {
    pub endpoint: Endpoint,
    pub method: &'static str,
    /// `{name}` segments are parameters, handed to the endpoint as arguments of that name.
    pub path: &'static str,
    /// The status of a successful answer.
    pub status: u16,
    pub description: &'static str,
    pub write: bool,
}

impl Route {
    fn label(&self) -> String {
        format!("{} {}", self.method, self.path)
    }
}

pub const ROUTES: &[Route] = &[
    Route {
        endpoint: Endpoint::Index,
        method: "GET",
        path: "/v1",
        status: 200,
        description: "This list of endpoints.",
        write: false,
    },
    Route {
        endpoint: Endpoint::ListArtifacts,
        method: "GET",
        path: "/v1/artifacts",
        status: 200,
        description: "List the artifacts (decisions run, review priority, flows) of this chat. Query: kind=decision|review_priority|flow.",
        write: false,
    },
    Route {
        endpoint: Endpoint::GetArtifact,
        method: "GET",
        path: "/v1/artifacts/{artifact_id}",
        status: 200,
        description: "Read one artifact with its content and provenance.",
        write: false,
    },
    Route {
        endpoint: Endpoint::ListDecisions,
        method: "GET",
        path: "/v1/decisions",
        status: 200,
        description: "List the engineering decisions of this chat.",
        write: false,
    },
    Route {
        endpoint: Endpoint::GetDecision,
        method: "GET",
        path: "/v1/decisions/{decision_id}",
        status: 200,
        description: "Read a decision with its discussion.",
        write: false,
    },
    Route {
        endpoint: Endpoint::RecordDecision,
        method: "POST",
        path: "/v1/decisions",
        status: 201,
        description: "Open an engineering decision as a thread in the Decisions tab. Body: title, summary, type?, context?, rationale?, files? [{path, start_line?, end_line?}], checkpoint_id?. A decision is a choice the reviewer should consciously accept or reject; call it once per decision.",
        write: true,
    },
    Route {
        endpoint: Endpoint::AddDecisionMessage,
        method: "POST",
        path: "/v1/decisions/{decision_id}/messages",
        status: 201,
        description: "Add a message to a decision's discussion. Body: text.",
        write: true,
    },
    Route {
        endpoint: Endpoint::LinkCommit,
        method: "POST",
        path: "/v1/decisions/{decision_id}/commits",
        status: 201,
        description: "Say that a commit influences a decision, with a note on how. Body: commit (id, short id, branch or tag), note?. Use it after committing work that settles, changes or contradicts a decision.",
        write: true,
    },
    Route {
        endpoint: Endpoint::CommentUnit,
        method: "POST",
        path: "/v1/comments",
        status: 201,
        description: "Leave a review comment on a component (function, method, type) of the review queue, or on a line of a file. Body: text, path?, unit?, line?, checkpoint_id?. Use it only when the user asks you to comment on code in the review; the comment is marked as yours.",
        write: true,
    },
    Route {
        endpoint: Endpoint::SetPriority,
        method: "PUT",
        path: "/v1/priority",
        status: 200,
        description: "Change where a component sits in the review queue, 0 to 100 (45 or more is High, 20 or more Medium), or put it back with reset. Body: path, unit, score?, reason?, reset?, checkpoint_id?. Use it only when the user asks you to re-prioritise; always give the reason.",
        write: true,
    },
    Route {
        endpoint: Endpoint::RecordFlow,
        method: "POST",
        path: "/v1/flows",
        status: 201,
        description: "Draw a diagram of how the code works in the Flow tab. Body: nodes [{id, label, kind?, description?, refs? [{path, line?}]}], edges? [{source, target, label?}], name?, summary?, checkpoint_id?. Ground every node in files that exist; nodes referring to files that do not exist are marked unverified.",
        write: true,
    },
];

impl Endpoint {
    pub fn route(self) -> &'static Route {
        ROUTES
            .iter()
            .find(|route| route.endpoint == self)
            .expect("every endpoint has a route")
    }
}

/// Matches `path` against a route pattern; `Some` holds the values of the `{name}` segments.
fn match_path(pattern: &'static str, path: &str) -> Option<Vec<(&'static str, String)>> {
    let mut params = Vec::new();
    let mut want = pattern.trim_matches('/').split('/');
    let mut have = path.trim_matches('/').split('/');
    loop {
        match (want.next(), have.next()) {
            (None, None) => return Some(params),
            (Some(want), Some(have)) if !have.is_empty() => {
                match want
                    .strip_prefix('{')
                    .and_then(|rest| rest.strip_suffix('}'))
                {
                    Some(name) => params.push((name, have.to_string())),
                    None if want == have => {}
                    None => return None,
                }
            }
            _ => return None,
        }
    }
}

type Params = Vec<(&'static str, String)>;

fn find_route(method: &str, path: &str) -> ApiResult<(&'static Route, Params)> {
    let mut path_known = false;
    for route in ROUTES {
        if let Some(params) = match_path(route.path, path) {
            path_known = true;
            if route.method == method {
                return Ok((route, params));
            }
        }
    }
    let shown: String = path.chars().take(100).collect();
    if path_known {
        Err(ApiError::new(
            ApiCode::MethodNotAllowed,
            format!("{method} is not allowed on {shown}"),
        ))
    } else {
        Err(ApiError::new(
            ApiCode::NotFound,
            format!("no such endpoint: {shown}"),
        ))
    }
}

fn index() -> Value {
    let endpoints: Vec<Value> = ROUTES
        .iter()
        .filter(|route| route.endpoint != Endpoint::Index)
        .map(|route| {
            json!({
                "method": route.method,
                "path": route.path,
                "description": route.description,
                "write": route.write,
            })
        })
        .collect();
    json!({ "version": 1, "endpoints": endpoints })
}

// ------------------------------------------------------------------ service

fn arg_uuid(args: &Value, key: &str) -> ApiResult<Uuid> {
    args.get(key)
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| ApiError::invalid(format!("`{key}` must be a UUID")))
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn not_found(message: &str) -> ApiError {
    ApiError::new(ApiCode::NotFound, message)
}

/// What one token may do: read and write the data of one chat session.
pub struct ApiService {
    db: Arc<dyn Database>,
    scope: SessionId,
    allow_write: bool,
}

impl ApiService {
    pub fn new(db: Arc<dyn Database>, scope: SessionId, allow_write: bool) -> Self {
        Self {
            db,
            scope,
            allow_write,
        }
    }

    /// The chat a call is about. A `session_id` in the request is optional; naming another
    /// session than the token's is refused.
    fn session_arg(&self, args: &Value) -> ApiResult<SessionId> {
        match args.get("session_id") {
            None | Some(Value::Null) => Ok(self.scope),
            Some(value) => {
                let requested = value
                    .as_str()
                    .and_then(|value| Uuid::parse_str(value).ok())
                    .map(SessionId)
                    .ok_or_else(|| ApiError::invalid("`session_id` must be a UUID"))?;
                if requested == self.scope {
                    Ok(self.scope)
                } else {
                    Err(ApiError::forbidden(
                        "that session is outside this token's scope",
                    ))
                }
            }
        }
    }

    /// The chat and the checkpoint a call is about: the one named, or the chat's newest.
    fn checkpoint_arg(&self, args: &Value) -> ApiResult<(SessionId, crate::domain::Checkpoint)> {
        let checkpoint = match args.get("checkpoint_id").and_then(Value::as_str) {
            Some(_) => self
                .db
                .get_checkpoint(CheckpointId(arg_uuid(args, "checkpoint_id")?))?
                .ok_or_else(|| not_found("checkpoint not found"))?,
            None => {
                let session = self.session_arg(args)?;
                self.db.latest_checkpoint(session)?.ok_or_else(|| {
                    ApiError::invalid(
                        "nothing has changed in this chat yet, so there is nothing to review",
                    )
                })?
            }
        };
        self.in_scope(checkpoint.session_id)?;
        Ok((checkpoint.session_id, checkpoint))
    }

    fn in_scope(&self, session_id: SessionId) -> ApiResult<()> {
        if session_id == self.scope {
            Ok(())
        } else {
            Err(ApiError::forbidden(
                "that item is outside this token's scope",
            ))
        }
    }

    fn require_write(&self) -> ApiResult<()> {
        if self.allow_write {
            Ok(())
        } else {
            Err(ApiError::forbidden(
                "this token is read-only, so it cannot update artifacts",
            ))
        }
    }

    /// Runs an endpoint and records the call in the audit trail.
    pub fn handle(&self, endpoint: Endpoint, args: &Value) -> ApiResult<Value> {
        let route = endpoint.route();
        let outcome = self.call(endpoint, args);
        self.audit(&route.label(), route.write, &outcome);
        outcome
    }

    /// Writes one line of the audit trail. `write` says the call was a write; it only counts
    /// when the call went through.
    pub fn audit(&self, label: &str, write: bool, outcome: &ApiResult<Value>) {
        let (ok, detail) = match outcome {
            Ok(value) => (true, value.to_string()),
            Err(error) => (false, error.message.clone()),
        };
        let _ = self.db.audit_api(
            &now_rfc3339().unwrap_or_default(),
            label,
            Some(&self.scope.0.to_string()),
            write && ok,
            ok,
            &detail.chars().take(300).collect::<String>(),
        );
    }

    /// Runs an endpoint without auditing it.
    pub fn call(&self, endpoint: Endpoint, args: &Value) -> ApiResult<Value> {
        if endpoint.route().write {
            self.require_write()?;
        }
        self.session_arg(args)?;
        let now = now_rfc3339()?;
        match endpoint {
            Endpoint::Index => Ok(index()),
            Endpoint::ListArtifacts => {
                let session = self.session_arg(args)?;
                let kind = match args.get("kind").and_then(Value::as_str) {
                    None => None,
                    Some(kind) => Some(ArtifactKind::parse(kind).ok_or_else(|| {
                        ApiError::invalid("`kind` must be decision, review_priority or flow")
                    })?),
                };
                Ok(json!(self.db.list_artifacts(session, kind)?))
            }
            Endpoint::GetArtifact => {
                let artifact = self
                    .db
                    .get_artifact(ArtifactId(arg_uuid(args, "artifact_id")?))?
                    .ok_or_else(|| not_found("artifact not found"))?;
                self.in_scope(artifact.session_id)?;
                Ok(json!(artifact))
            }
            Endpoint::ListDecisions => {
                let session = self.session_arg(args)?;
                Ok(json!(self.db.list_decisions(session)?))
            }
            Endpoint::GetDecision => {
                let id = DecisionId(arg_uuid(args, "decision_id")?);
                let decision = self
                    .db
                    .get_decision(id)?
                    .ok_or_else(|| not_found("decision not found"))?;
                self.in_scope(decision.session_id)?;
                Ok(json!({ "decision": decision, "messages": self.db.list_decision_messages(id)? }))
            }
            Endpoint::RecordDecision => self.record_decision(args, now),
            Endpoint::CommentUnit => self.comment_unit(args, now),
            Endpoint::SetPriority => self.set_priority(args, now),
            Endpoint::RecordFlow => self.record_flow(args, now),
            Endpoint::LinkCommit => self.link_commit(args, now),
            Endpoint::AddDecisionMessage => self.add_decision_message(args, now),
        }
    }

    fn record_decision(&self, args: &Value, now: String) -> ApiResult<Value> {
        let session = self.session_arg(args)?;
        let checkpoint = match args.get("checkpoint_id").and_then(Value::as_str) {
            Some(_) => self
                .db
                .get_checkpoint(CheckpointId(arg_uuid(args, "checkpoint_id")?))?
                .ok_or_else(|| not_found("checkpoint not found"))?,
            None => self.db.latest_checkpoint(session)?.ok_or_else(|| {
                ApiError::invalid(
                    "nothing has changed in this chat yet, so there is nothing to decide about",
                )
            })?,
        };
        self.in_scope(checkpoint.session_id)?;
        let (title, summary) = (arg_str(args, "title"), arg_str(args, "summary"));
        if title.is_empty() || summary.is_empty() {
            return Err(ApiError::invalid("title and summary are required"));
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
        Ok(json!(decision))
    }

    fn comment_unit(&self, args: &Value, now: String) -> ApiResult<Value> {
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
        Ok(json!({ "done": done }))
    }

    fn set_priority(&self, args: &Value, now: String) -> ApiResult<Value> {
        let (session, checkpoint) = self.checkpoint_arg(args)?;
        let priority = crate::app::actions::stored_priority(
            self.db.as_ref(),
            checkpoint.id,
            session,
            crate::app::engine::PRIORITY_VERSION,
        )?
        .ok_or_else(|| not_found("this checkpoint has no review queue yet"))?;
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
                .ok_or_else(|| ApiError::invalid("`score` must be a number from 0 to 100"))?;
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
        Ok(json!({ "done": done }))
    }

    fn record_flow(&self, args: &Value, now: String) -> ApiResult<Value> {
        let (session, checkpoint) = self.checkpoint_arg(args)?;
        let chat = self
            .db
            .get_session(session)?
            .ok_or_else(|| not_found("session not found"))?;
        let worktree = self
            .db
            .get_worktree(chat.worktree_id)?
            .ok_or_else(|| not_found("worktree not found"))?;
        let known: std::collections::HashSet<String> = crate::adapters::git::GitCli
            .list_files(&worktree.path)?
            .into_iter()
            .collect();
        let graph = crate::app::analysis::parse_flow(&args.to_string(), &known)?;
        if graph.nodes.is_empty() {
            return Err(ApiError::invalid("a diagram needs at least one node"));
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
        Ok(json!({
            "done": format!("Drew a diagram with {} nodes", graph.nodes.len()),
            "artifact_id": stored.id.0.to_string(),
        }))
    }

    fn link_commit(&self, args: &Value, now: String) -> ApiResult<Value> {
        let id = DecisionId(arg_uuid(args, "decision_id")?);
        let decision = self
            .db
            .get_decision(id)?
            .ok_or_else(|| not_found("decision not found"))?;
        self.in_scope(decision.session_id)?;
        let commit = arg_str(args, "commit");
        if commit.is_empty() {
            return Err(ApiError::invalid("`commit` is required"));
        }
        let session = self
            .db
            .get_session(decision.session_id)?
            .ok_or_else(|| not_found("session not found"))?;
        let worktree = self
            .db
            .get_worktree(session.worktree_id)?
            .ok_or_else(|| not_found("worktree not found"))?;
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
        Ok(json!(linked))
    }

    fn add_decision_message(&self, args: &Value, now: String) -> ApiResult<Value> {
        let id = DecisionId(arg_uuid(args, "decision_id")?);
        let decision = self
            .db
            .get_decision(id)?
            .ok_or_else(|| not_found("decision not found"))?;
        self.in_scope(decision.session_id)?;
        let text = arg_str(args, "text");
        if text.is_empty() {
            return Err(ApiError::invalid("`text` is required"));
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
        Ok(json!(message))
    }
}

// ------------------------------------------------------------------ tokens

/// Largest request body taken, in bytes.
const MAX_BODY: usize = 1 << 20;
/// Largest request line plus headers taken, in bytes.
const MAX_HEAD: usize = 16 * 1024;
/// How long one read or write may stall.
const IO_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a whole request may take to arrive.
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
/// Connections served at once; more are told to come back.
const MAX_CONNECTIONS: usize = 32;
/// What is read and thrown away after an early answer, so the client still sees it.
const DRAIN_LIMIT: usize = 8 << 20;
const DRAIN_TIME: Duration = Duration::from_secs(2);

struct Grant {
    token: String,
    session: SessionId,
    write: bool,
}

/// Compares in time that depends only on the length, not on where the bytes differ.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

fn new_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

struct ServerInner {
    db: Arc<dyn Database>,
    grants: Mutex<Vec<Grant>>,
    port: u16,
    stop: AtomicBool,
    active: AtomicUsize,
}

impl ServerInner {
    /// Looks the token up against every grant, so the time does not tell which one matched.
    fn authenticate(&self, presented: &str) -> Option<(SessionId, bool)> {
        let grants = self.grants.lock();
        let mut found = None;
        for grant in grants.iter() {
            if constant_time_eq(grant.token.as_bytes(), presented.as_bytes()) {
                found = Some((grant.session, grant.write));
            }
        }
        found
    }

    fn host_allowed(&self, host: Option<&str>) -> bool {
        let Some(host) = host else { return false };
        let host = host.to_ascii_lowercase();
        host == format!("127.0.0.1:{}", self.port) || host == format!("localhost:{}", self.port)
    }
}

/// Holds a slot among the connections being served until dropped.
struct Slot(Arc<ServerInner>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct ApiServer {
    inner: Arc<ServerInner>,
}

impl ApiServer {
    /// Binds `127.0.0.1` on a port the OS picks and starts answering in the background.
    pub fn start(db: Arc<dyn Database>) -> Result<Arc<Self>> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
            Error::new(ErrorCode::Io, format!("could not bind the API: {error}"))
        })?;
        let port = listener
            .local_addr()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?
            .port();
        let inner = Arc::new(ServerInner {
            db,
            grants: Mutex::new(Vec::new()),
            port,
            stop: AtomicBool::new(false),
            active: AtomicUsize::new(0),
        });
        let accepting = Arc::clone(&inner);
        thread::Builder::new()
            .name("ataraxia-api".into())
            .spawn(move || accept_loop(listener, accepting))
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        Ok(Arc::new(Self { inner }))
    }

    pub fn port(&self) -> u16 {
        self.inner.port
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.inner.port)
    }

    /// A fresh token for one chat session, read-write or read-only.
    pub fn issue_token(&self, session: SessionId, write: bool) -> ApiAccess {
        let token = new_token();
        self.inner.grants.lock().push(Grant {
            token: token.clone(),
            session,
            write,
        });
        ApiAccess {
            url: self.url(),
            token,
        }
    }

    pub fn revoke_token(&self, token: &str) {
        self.inner
            .grants
            .lock()
            .retain(|grant| !constant_time_eq(grant.token.as_bytes(), token.as_bytes()));
    }

    /// How many tokens are live (tests and diagnostics).
    pub fn live_tokens(&self) -> usize {
        self.inner.grants.lock().len()
    }
}

impl ApiGateway for ApiServer {
    fn issue(&self, session_id: SessionId, write: bool) -> ApiAccess {
        self.issue_token(session_id, write)
    }

    fn revoke(&self, token: &str) {
        self.revoke_token(token);
    }
}

impl Drop for ApiServer {
    fn drop(&mut self) {
        // Wakes the accept loop so it sees the flag and ends.
        self.inner.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.inner.port));
    }
}

// ------------------------------------------------------------------ http

fn accept_loop(listener: TcpListener, inner: Arc<ServerInner>) {
    for stream in listener.incoming() {
        if inner.stop.load(Ordering::SeqCst) {
            break;
        }
        let mut stream = match stream {
            Ok(stream) => stream,
            Err(_) => {
                thread::sleep(Duration::from_millis(50));
                continue;
            }
        };
        let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
        let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
        if inner.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            inner.active.fetch_sub(1, Ordering::SeqCst);
            let busy = Reply::error(
                &ApiError::new(ApiCode::Internal, "too many connections, try again"),
                503,
            );
            let _ = write_reply(&mut stream, &busy);
            continue;
        }
        let slot = Slot(Arc::clone(&inner));
        let worker = Arc::clone(&inner);
        let spawned = thread::Builder::new()
            .name("ataraxia-api-conn".into())
            .spawn(move || {
                let _slot = slot;
                serve(&worker, stream);
            });
        // A failed spawn drops the closure, and with it the slot and the stream.
        let _ = spawned;
    }
}

struct Reply {
    status: u16,
    body: Value,
    headers: Vec<(&'static str, &'static str)>,
}

impl Reply {
    fn ok(status: u16, body: Value) -> Self {
        Self {
            status,
            body,
            headers: Vec::new(),
        }
    }

    fn error(error: &ApiError, status: u16) -> Self {
        let mut reply = Self::ok(status, error.body());
        if error.code == ApiCode::Unauthorized {
            reply.headers.push(("WWW-Authenticate", "Bearer"));
        }
        if error.code == ApiCode::MethodNotAllowed {
            reply.headers.push(("Allow", "GET, POST, PUT"));
        }
        reply
    }

    fn from_error(error: &ApiError) -> Self {
        Self::error(error, error.code.status())
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    }
}

fn write_reply(stream: &mut TcpStream, reply: &Reply) -> std::io::Result<()> {
    let body = reply.body.to_string();
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n",
        reply.status,
        reason(reply.status),
        body.len()
    );
    for (name, value) in &reply.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

/// What the request line and headers said.
struct Head {
    method: String,
    target: String,
    host: Option<String>,
    authorization: Option<String>,
    content_length: usize,
    chunked: bool,
    expect_continue: bool,
    /// Bytes of the body that came in with the headers.
    early_body: Vec<u8>,
}

enum Failure {
    Reply(ApiError),
    /// Nothing worth answering: the client left or stalled.
    Close,
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn read_some(stream: &mut TcpStream, buf: &mut [u8]) -> std::io::Result<usize> {
    loop {
        match stream.read(buf) {
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            other => return other,
        }
    }
}

fn read_head(stream: &mut TcpStream, deadline: Instant) -> std::result::Result<Head, Failure> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(at) = find(&buf, b"\r\n\r\n") {
            break at;
        }
        if buf.len() > MAX_HEAD {
            return Err(Failure::Reply(ApiError::new(
                ApiCode::TooLarge,
                "the request headers are too large",
            )));
        }
        if Instant::now() >= deadline {
            return Err(Failure::Close);
        }
        match read_some(stream, &mut chunk) {
            Ok(0) | Err(_) => return Err(Failure::Close),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let early_body = buf.split_off(end + 4);
    buf.truncate(end);
    parse_head(&buf, early_body).map_err(Failure::Reply)
}

fn parse_head(raw: &[u8], early_body: Vec<u8>) -> ApiResult<Head> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| ApiError::invalid("the request headers are not valid text"))?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(ApiError::invalid("malformed request line"));
    };
    if !version.starts_with("HTTP/1.") {
        return Err(ApiError::invalid("only HTTP/1.x is supported"));
    }
    let mut head = Head {
        method: method.to_string(),
        target: target.to_string(),
        host: None,
        authorization: None,
        content_length: 0,
        chunked: false,
        expect_continue: false,
        early_body,
    };
    let (mut saw_length, mut saw_host, mut saw_auth) = (false, false, false);
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(ApiError::invalid("malformed header line"));
        };
        let value = value.trim();
        let once = |seen: &mut bool, name: &str| -> ApiResult<()> {
            if std::mem::replace(seen, true) {
                Err(ApiError::invalid(format!("duplicate {name} header")))
            } else {
                Ok(())
            }
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "host" => {
                once(&mut saw_host, "Host")?;
                head.host = Some(value.to_string());
            }
            "authorization" => {
                once(&mut saw_auth, "Authorization")?;
                head.authorization = Some(value.to_string());
            }
            "content-length" => {
                once(&mut saw_length, "Content-Length")?;
                if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(ApiError::invalid("Content-Length must be a number"));
                }
                // A number too big for usize is far over the limit anyway.
                head.content_length = value.parse().unwrap_or(usize::MAX);
            }
            "transfer-encoding" => head.chunked = true,
            "expect" => head.expect_continue = value.eq_ignore_ascii_case("100-continue"),
            _ => {}
        }
    }
    Ok(head)
}

/// The token of an `Authorization: Bearer <token>` header.
fn bearer(header: Option<&str>) -> Option<&str> {
    let (scheme, token) = header?.trim().split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then_some(token)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'%' => {
                let hex = text.get(at + 1..at + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                at += 3;
            }
            b'+' => {
                out.push(b' ');
                at += 1;
            }
            byte => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn parse_query(query: &str) -> ApiResult<Vec<(String, String)>> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            match (percent_decode(key), percent_decode(value)) {
                (Some(key), Some(value)) => Ok((key, value)),
                _ => Err(ApiError::invalid("the query string is not valid")),
            }
        })
        .collect()
}

fn read_body(stream: &mut TcpStream, head: &mut Head, deadline: Instant) -> ApiResult<Vec<u8>> {
    let length = head.content_length;
    let mut body = std::mem::take(&mut head.early_body);
    body.truncate(length);
    if body.len() < length && head.expect_continue {
        let _ = stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
    }
    let mut chunk = [0u8; 8192];
    while body.len() < length {
        if Instant::now() >= deadline {
            return Err(ApiError::invalid("the request body did not arrive in time"));
        }
        let want = chunk.len().min(length - body.len());
        match read_some(stream, &mut chunk[..want]) {
            Ok(0) | Err(_) => return Err(ApiError::invalid("the request body ended early")),
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    Ok(body)
}

/// The arguments of a call: the JSON body (for `POST` and `PUT`), the query string (for `GET`),
/// and the values in the path, which win.
fn build_args(route: &Route, body: &[u8], query: &str, params: Params) -> ApiResult<Value> {
    let mut args = Map::new();
    if route.method == "GET" {
        for (key, value) in parse_query(query)? {
            args.insert(key, Value::String(value));
        }
    } else if !body.iter().all(u8::is_ascii_whitespace) {
        match serde_json::from_slice::<Value>(body) {
            Ok(Value::Object(map)) => args = map,
            Ok(_) => return Err(ApiError::invalid("the body must be a JSON object")),
            Err(error) => {
                return Err(ApiError::invalid(format!(
                    "the body is not valid JSON: {error}"
                )));
            }
        }
    }
    for (name, value) in params {
        args.insert(name.to_string(), Value::String(value));
    }
    Ok(Value::Object(args))
}

/// Answers one request. `Err(Failure::Close)` means there is nobody to answer.
fn respond(
    inner: &ServerInner,
    stream: &mut TcpStream,
    deadline: Instant,
) -> std::result::Result<Reply, Failure> {
    let mut head = read_head(stream, deadline)?;
    // A browser on another site reaches this port only under a name that is not ours.
    if !inner.host_allowed(head.host.as_deref()) {
        return Err(Failure::Reply(ApiError::forbidden(format!(
            "the Host header must be 127.0.0.1:{port} or localhost:{port}",
            port = inner.port
        ))));
    }
    let Some((session, write)) =
        bearer(head.authorization.as_deref()).and_then(|presented| inner.authenticate(presented))
    else {
        return Err(Failure::Reply(ApiError::new(
            ApiCode::Unauthorized,
            "send a valid token as `Authorization: Bearer <token>`",
        )));
    };

    // From here on the caller is known, so every call is audited.
    let service = ApiService::new(Arc::clone(&inner.db), session, write);
    let target = head.target.clone();
    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    let (route, params) = match find_route(&head.method, path) {
        Ok(found) => found,
        Err(error) => {
            service.audit("unmatched", false, &Err(error.clone()));
            return Ok(Reply::from_error(&error));
        }
    };
    let outcome = (|| {
        if head.chunked {
            return Err(ApiError::invalid(
                "chunked request bodies are not supported, send a Content-Length",
            ));
        }
        if head.content_length > MAX_BODY {
            return Err(ApiError::new(
                ApiCode::TooLarge,
                format!("the body may be at most {MAX_BODY} bytes"),
            ));
        }
        let body = read_body(stream, &mut head, deadline)?;
        build_args(route, &body, query, params)
    })();
    let result = match outcome {
        Ok(args) => service.handle(route.endpoint, &args),
        Err(error) => {
            service.audit(&route.label(), route.write, &Err(error.clone()));
            Err(error)
        }
    };
    Ok(match result {
        Ok(value) => Reply::ok(route.status, value),
        Err(error) => Reply::from_error(&error),
    })
}

fn serve(inner: &ServerInner, mut stream: TcpStream) {
    let deadline = Instant::now() + REQUEST_DEADLINE;
    let reply = match respond(inner, &mut stream, deadline) {
        Ok(reply) => reply,
        Err(Failure::Reply(error)) => Reply::from_error(&error),
        Err(Failure::Close) => return,
    };
    if write_reply(&mut stream, &reply).is_err() {
        return;
    }
    // Closing with unread input makes the OS reset the connection and the client can lose the
    // answer, so say we are done and let the rest of the request run out.
    let _ = stream.shutdown(Shutdown::Write);
    let _ = stream.set_read_timeout(Some(DRAIN_TIME));
    let until = Instant::now() + DRAIN_TIME;
    let (mut drained, mut chunk) = (0, [0u8; 8192]);
    while drained < DRAIN_LIMIT && Instant::now() < until {
        match read_some(&mut stream, &mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => drained += n,
        }
    }
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

    /// A git repository with one commit holding `a.py`.
    fn repo_with_a_file() -> std::path::PathBuf {
        let repo = std::env::temp_dir().join(format!("ataraxia-api-{}", Uuid::new_v4()));
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
        git(&["commit", "-q", "-m", "hash the tokens"]);
        repo
    }

    /// Gives the checkpoint a review queue with one unit, `go` in `a.py`.
    fn seed_review_queue(db: &SqliteStore, session: SessionId, checkpoint: CheckpointId) {
        let unit = json!({"id":"u1","name":"go","kind":"function","path":"a.py","start_line":1,"end_line":2,
            "side":"head","change":"modified","signature_changed":false,"public":true,"references":0,
            "additions":1,"deletions":0,"score":10,"level":"low","reasons":[],"container":null});
        db.ensure_artifact(&crate::domain::Artifact {
            id: ArtifactId::new(),
            session_id: session,
            checkpoint_id: checkpoint,
            kind: ArtifactKind::ReviewPriority,
            dedupe_key: String::new(),
            version: 1,
            status: crate::domain::ArtifactStatus::Ready,
            content: json!({"components":[],"files":[],"units":[unit],"languages":[]}),
            provenance: json!({"version": crate::app::engine::PRIORITY_VERSION}),
            error: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        })
        .unwrap();
    }

    fn service(db: &Arc<SqliteStore>, scope: SessionId, write: bool) -> ApiService {
        ApiService::new(db.clone(), scope, write)
    }

    fn error_of(outcome: ApiResult<Value>) -> ApiError {
        outcome.expect_err("the call should have been refused")
    }

    #[test]
    fn paths_match_their_pattern_and_hand_over_the_parameters() {
        assert_eq!(match_path("/v1/decisions", "/v1/decisions"), Some(vec![]));
        assert_eq!(match_path("/v1/decisions", "/v1/decisions/"), Some(vec![]));
        assert_eq!(match_path("/v1/decisions", "/v1/decision"), None);
        assert_eq!(match_path("/v1/decisions", "/v1/decisions/x"), None);
        assert_eq!(
            match_path(
                "/v1/decisions/{decision_id}/messages",
                "/v1/decisions/abc/messages"
            ),
            Some(vec![("decision_id", "abc".to_string())])
        );
        assert_eq!(
            match_path("/v1/decisions/{decision_id}", "/v1/decisions//"),
            None
        );
        assert_eq!(
            match_path("/v1/decisions/{decision_id}", "/v1/decisions"),
            None
        );
    }

    #[test]
    fn tokens_are_compared_without_stopping_at_the_first_difference() {
        assert!(constant_time_eq(b"abcdef", b"abcdef"));
        assert!(!constant_time_eq(b"abcdef", b"abcdeg"));
        assert!(!constant_time_eq(b"abcdef", b"abcde"));
        assert!(!constant_time_eq(b"", b"a"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn a_token_is_sixty_four_hex_characters_and_never_repeats() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn the_query_string_is_decoded() {
        assert_eq!(
            parse_query("kind=flow&x=a%20b+c&empty").unwrap(),
            vec![
                ("kind".to_string(), "flow".to_string()),
                ("x".to_string(), "a b c".to_string()),
                ("empty".to_string(), String::new()),
            ]
        );
        assert!(parse_query("a=%zz").is_err());
    }

    #[test]
    fn writes_need_authorization_scope_is_enforced_and_everything_is_audited() {
        let (db, a, b, cp) = seeded();
        let read_only = service(&db, a, false);
        let denied = error_of(read_only.handle(
            Endpoint::RecordDecision,
            &json!({"checkpoint_id": cp.0.to_string(), "title":"t","summary":"s"}),
        ));
        assert_eq!(denied.code, ApiCode::Forbidden);
        assert!(db.list_decisions(a).unwrap().is_empty());

        let writer = service(&db, a, true);
        writer
            .handle(
                Endpoint::RecordDecision,
                &json!({"checkpoint_id": cp.0.to_string(), "type":"security","title":"Hash it","summary":"hashed"}),
            )
            .unwrap();
        assert_eq!(db.list_decisions(a).unwrap().len(), 1);
        let id = db.list_decisions(a).unwrap()[0].id;
        writer
            .handle(
                Endpoint::AddDecisionMessage,
                &json!({"decision_id": id.0.to_string(), "text":"noted"}),
            )
            .unwrap();
        assert_eq!(db.list_decision_messages(id).unwrap()[0].author, "agent");

        // Asked in the chat, the agent needs no checkpoint id, and says which code it is about.
        writer
            .handle(
                Endpoint::RecordDecision,
                &json!({"title":"Keep the cache","summary":"kept","files":[{"path":"a.py","start_line":3}]}),
            )
            .unwrap();
        let recorded = db.list_decisions(a).unwrap();
        assert_eq!(recorded[1].seq, 2);
        assert_eq!(recorded[1].opened_by, "agent");
        assert_eq!(recorded[1].checkpoint_id, cp);
        assert_eq!(recorded[1].refs[0].path, "a.py");
        assert_eq!(recorded[1].refs[0].end_line, Some(3));

        // Another chat's data is out of scope, however it is asked for.
        let other = error_of(writer.handle(
            Endpoint::ListDecisions,
            &json!({"session_id": b.0.to_string()}),
        ));
        assert_eq!(other.code, ApiCode::Forbidden);
        // The same session named explicitly is fine.
        writer
            .handle(
                Endpoint::ListDecisions,
                &json!({"session_id": a.0.to_string()}),
            )
            .unwrap();

        assert_eq!(db.audit_count(), 6);
    }

    #[test]
    fn what_belongs_to_another_chat_is_forbidden_even_by_id() {
        let (db, a, b, cp) = seeded();
        let writer = service(&db, a, true);
        writer
            .handle(
                Endpoint::RecordDecision,
                &json!({"title":"t","summary":"s"}),
            )
            .unwrap();
        let id = db.list_decisions(a).unwrap()[0].id;
        let stranger = service(&db, b, true);
        let args = json!({"decision_id": id.0.to_string(), "text": "hi"});
        for endpoint in [Endpoint::GetDecision, Endpoint::AddDecisionMessage] {
            assert_eq!(
                error_of(stranger.handle(endpoint, &args)).code,
                ApiCode::Forbidden
            );
        }
        let named = json!({"checkpoint_id": cp.0.to_string(), "title":"t","summary":"s"});
        assert_eq!(
            error_of(stranger.handle(Endpoint::RecordDecision, &named)).code,
            ApiCode::Forbidden
        );
        assert!(db.list_decision_messages(id).unwrap().is_empty());
        assert_eq!(db.list_decisions(a).unwrap().len(), 1);
    }

    #[test]
    fn the_agent_links_a_commit_to_a_decision_and_a_bad_commit_is_refused() {
        let repo = repo_with_a_file();
        let (db, a, _, _) = seeded_at(repo.clone());
        let writer = service(&db, a, true);
        writer
            .handle(
                Endpoint::RecordDecision,
                &json!({"title":"Hash it","summary":"hashed"}),
            )
            .unwrap();
        let id = db.list_decisions(a).unwrap()[0].id;
        writer
            .handle(
                Endpoint::LinkCommit,
                &json!({"decision_id": id.0.to_string(), "commit": "HEAD", "note": "Implements it"}),
            )
            .unwrap();
        let linked = db.list_decision_commits(id).unwrap();
        assert_eq!(linked.len(), 1);
        assert_eq!(linked[0].linked_by, "agent");
        assert_eq!(linked[0].subject, "hash the tokens");
        assert_eq!(linked[0].author, "Ana");
        assert_eq!(linked[0].note, "Implements it");

        let bad = error_of(writer.handle(
            Endpoint::LinkCommit,
            &json!({"decision_id": id.0.to_string(), "commit": "no-such-commit"}),
        ));
        assert_eq!(bad.code, ApiCode::NotFound);
        let missing = error_of(writer.handle(
            Endpoint::LinkCommit,
            &json!({"decision_id": id.0.to_string()}),
        ));
        assert_eq!(missing.code, ApiCode::Invalid);
        let read_only = service(&db, a, false);
        let denied = error_of(read_only.handle(
            Endpoint::LinkCommit,
            &json!({"decision_id": id.0.to_string(), "commit": "HEAD"}),
        ));
        assert_eq!(denied.code, ApiCode::Forbidden);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn in_the_chat_the_agent_comments_on_a_component_changes_its_priority_and_draws_a_flow() {
        let repo = repo_with_a_file();
        let (db, a, _, cp) = seeded_at(repo.clone());
        seed_review_queue(&db, a, cp);

        let writer = service(&db, a, true);
        let read_only = service(&db, a, false);
        let comment = json!({"path":"a.py","unit":"go","text":"Why does this return a constant?"});
        assert_eq!(
            error_of(read_only.handle(Endpoint::CommentUnit, &comment)).code,
            ApiCode::Forbidden
        );
        writer.handle(Endpoint::CommentUnit, &comment).unwrap();
        let comments = db.list_review_comments(cp).unwrap();
        assert_eq!(
            (comments[0].author.as_str(), comments[0].line),
            ("agent", Some(1))
        );
        let missing = writer.handle(
            Endpoint::CommentUnit,
            &json!({"path":"a.py","unit":"nope","text":"x"}),
        );
        assert!(missing.is_err());

        writer
            .handle(
                Endpoint::SetPriority,
                &json!({"path":"a.py","unit":"go","score":90,"reason":"public entry"}),
            )
            .unwrap();
        let stored = db.list_unit_priorities(cp).unwrap();
        assert_eq!((stored[0].score, stored[0].set_by.as_str()), (90, "agent"));
        let bad = error_of(writer.handle(
            Endpoint::SetPriority,
            &json!({"path":"a.py","unit":"go","score":150}),
        ));
        assert_eq!(bad.code, ApiCode::Invalid);
        writer
            .handle(
                Endpoint::SetPriority,
                &json!({"path":"a.py","unit":"go","reset":true}),
            )
            .unwrap();
        assert!(db.list_unit_priorities(cp).unwrap().is_empty());

        writer
            .handle(
                Endpoint::RecordFlow,
                &json!({"name":"Entry to storage","summary":"s","nodes":[
                    {"id":"n1","label":"go","kind":"function","description":"d","refs":[{"path":"a.py","line":1}]},
                    {"id":"n2","label":"store","kind":"data","description":"d","refs":[{"path":"invented.py","line":1}]}],
                  "edges":[{"source":"n1","target":"n2","label":"writes"},{"source":"n1","target":"ghost","label":"x"}]}),
            )
            .unwrap();
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
        let empty = error_of(writer.handle(Endpoint::RecordFlow, &json!({"nodes":[]})));
        assert_eq!(empty.code, ApiCode::Invalid);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn the_list_of_artifacts_can_be_filtered_and_a_bad_kind_is_refused() {
        let (db, a, _, cp) = seeded();
        seed_review_queue(&db, a, cp);
        let reader = service(&db, a, false);
        let all = reader.handle(Endpoint::ListArtifacts, &json!({})).unwrap();
        assert_eq!(all.as_array().unwrap().len(), 1);
        let flows = reader
            .handle(Endpoint::ListArtifacts, &json!({"kind":"flow"}))
            .unwrap();
        assert!(flows.as_array().unwrap().is_empty());
        let bad = error_of(reader.handle(Endpoint::ListArtifacts, &json!({"kind":"nope"})));
        assert_eq!(bad.code, ApiCode::Invalid);
        let id = all[0]["id"].as_str().unwrap().to_string();
        let one = reader
            .handle(Endpoint::GetArtifact, &json!({"artifact_id": id}))
            .unwrap();
        assert_eq!(one["kind"], "review_priority");
        let unknown = error_of(reader.handle(
            Endpoint::GetArtifact,
            &json!({"artifact_id": Uuid::new_v4().to_string()}),
        ));
        assert_eq!(unknown.code, ApiCode::NotFound);
    }

    // ---------------------------------------------------------------- http

    struct Answer {
        status: u16,
        head: String,
        body: Value,
    }

    /// Sends the bytes as they are and reads the whole answer.
    fn send(port: u16, raw: &[u8]) -> Answer {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let _ = stream.write_all(raw);
        let mut reply = Vec::new();
        let _ = stream.read_to_end(&mut reply);
        let text = String::from_utf8_lossy(&reply).into_owned();
        let (head, body) = text.split_once("\r\n\r\n").expect("an HTTP answer");
        let status = head
            .split(' ')
            .nth(1)
            .and_then(|code| code.parse().ok())
            .expect("a status line");
        Answer {
            status,
            head: head.to_string(),
            body: serde_json::from_str(body).unwrap_or(Value::Null),
        }
    }

    struct Request<'a> {
        method: &'a str,
        path: &'a str,
        token: Option<&'a str>,
        host: Option<String>,
        body: Option<Value>,
    }

    fn req<'a>(method: &'a str, path: &'a str, token: Option<&'a str>) -> Request<'a> {
        Request {
            method,
            path,
            token,
            host: None,
            body: None,
        }
    }

    impl Request<'_> {
        fn with(mut self, body: Value) -> Self {
            self.body = Some(body);
            self
        }

        fn host(mut self, host: &str) -> Self {
            self.host = Some(host.to_string());
            self
        }

        fn go(self, server: &ApiServer) -> Answer {
            let host = self
                .host
                .unwrap_or_else(|| format!("127.0.0.1:{}", server.port()));
            let mut raw = format!(
                "{} {} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n",
                self.method, self.path
            );
            if let Some(token) = self.token {
                raw.push_str(&format!("Authorization: Bearer {token}\r\n"));
            }
            let body = self.body.map(|body| body.to_string());
            if let Some(body) = &body {
                raw.push_str(&format!(
                    "Content-Type: application/json\r\nContent-Length: {}\r\n",
                    body.len()
                ));
            }
            raw.push_str("\r\n");
            raw.push_str(body.as_deref().unwrap_or_default());
            send(server.port(), raw.as_bytes())
        }
    }

    fn start(db: &Arc<SqliteStore>) -> Arc<ApiServer> {
        ApiServer::start(db.clone()).unwrap()
    }

    fn code(answer: &Answer) -> &str {
        answer.body["error"]["code"].as_str().unwrap_or_default()
    }

    #[test]
    fn the_server_listens_on_loopback_only_and_names_its_address() {
        let (db, ..) = seeded();
        let server = start(&db);
        assert!(server.url().starts_with("http://127.0.0.1:"));
        assert_ne!(server.port(), 0);
        let access = server.issue_token(SessionId::new(), true);
        assert_eq!(access.url, server.url());
        assert_eq!(access.token.len(), 64);
    }

    #[test]
    fn a_call_without_a_valid_token_is_unauthorized() {
        let (db, a, ..) = seeded();
        let server = start(&db);
        let access = server.issue_token(a, true);

        let missing = req("GET", "/v1/decisions", None).go(&server);
        assert_eq!((missing.status, code(&missing)), (401, "unauthorized"));
        assert!(missing.head.contains("WWW-Authenticate: Bearer"));

        let wrong = req("GET", "/v1/decisions", Some(&"0".repeat(64))).go(&server);
        assert_eq!((wrong.status, code(&wrong)), (401, "unauthorized"));
        let short = req("GET", "/v1/decisions", Some("abc")).go(&server);
        assert_eq!(short.status, 401);
        let near = format!("{}0", &access.token[..63]);
        assert_eq!(
            req("GET", "/v1/decisions", Some(&near)).go(&server).status,
            401
        );

        let basic = send(
            server.port(),
            format!(
                "GET /v1/decisions HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Basic {}\r\n\r\n",
                server.port(),
                access.token
            )
            .as_bytes(),
        );
        assert_eq!(basic.status, 401);

        let fine = req("GET", "/v1/decisions", Some(&access.token)).go(&server);
        assert_eq!(fine.status, 200);
        assert_eq!(fine.body, json!([]));
        assert!(!fine.head.to_ascii_lowercase().contains("access-control"));
        // Failed attempts are not audited, calls that are known are.
        assert_eq!(db.audit_count(), 1);
    }

    #[test]
    fn the_host_header_must_be_ours() {
        let (db, a, ..) = seeded();
        let server = start(&db);
        let access = server.issue_token(a, true);
        let token = Some(access.token.as_str());
        let port = server.port();
        for host in [
            "evil.example".to_string(),
            "evil.example:80".to_string(),
            format!("127.0.0.1:{}", port + 1),
            "127.0.0.1".to_string(),
        ] {
            let answer = req("GET", "/v1/decisions", token).host(&host).go(&server);
            assert_eq!((answer.status, code(&answer)), (403, "forbidden"), "{host}");
        }
        let none = send(
            port,
            format!(
                "GET /v1/decisions HTTP/1.1\r\nAuthorization: Bearer {}\r\n\r\n",
                access.token
            )
            .as_bytes(),
        );
        assert_eq!(none.status, 403);
        for host in [format!("localhost:{port}"), format!("LocalHost:{port}")] {
            let answer = req("GET", "/v1/decisions", token).host(&host).go(&server);
            assert_eq!(answer.status, 200, "{host}");
        }
        // A wrong host is refused before the token is looked at.
        let answer = req("GET", "/v1/decisions", None)
            .host("evil.example")
            .go(&server);
        assert_eq!(answer.status, 403);
    }

    #[test]
    fn unknown_paths_and_wrong_methods_are_told_apart() {
        let (db, a, ..) = seeded();
        let server = start(&db);
        let token = server.issue_token(a, true).token;
        let token = Some(token.as_str());
        let unknown = req("GET", "/v1/nope", token).go(&server);
        assert_eq!((unknown.status, code(&unknown)), (404, "not_found"));
        assert_eq!(req("GET", "/", token).go(&server).status, 404);
        assert_eq!(req("GET", "/v2/decisions", token).go(&server).status, 404);
        let wrong = req("DELETE", "/v1/decisions", token).go(&server);
        assert_eq!((wrong.status, code(&wrong)), (405, "method_not_allowed"));
        assert_eq!(req("GET", "/v1/comments", token).go(&server).status, 405);
        assert_eq!(req("POST", "/v1/priority", token).go(&server).status, 405);
        assert_eq!(req("POST", "/v1", token).go(&server).status, 405);
        // Unknown routes are audited under the caller's session too.
        assert_eq!(db.audit_count(), 7);
    }

    #[test]
    fn the_index_lists_every_endpoint() {
        let (db, a, ..) = seeded();
        let server = start(&db);
        let token = server.issue_token(a, false).token;
        let answer = req("GET", "/v1", Some(&token)).go(&server);
        assert_eq!(answer.status, 200);
        assert_eq!(answer.body["version"], 1);
        let endpoints = answer.body["endpoints"].as_array().unwrap();
        assert_eq!(endpoints.len(), 10);
        let has = |method: &str, path: &str, write: bool| {
            endpoints.iter().any(|item| {
                item["method"] == method
                    && item["path"] == path
                    && item["write"] == write
                    && !item["description"].as_str().unwrap_or_default().is_empty()
            })
        };
        assert!(has("GET", "/v1/artifacts", false));
        assert!(has("GET", "/v1/artifacts/{artifact_id}", false));
        assert!(has("GET", "/v1/decisions", false));
        assert!(has("GET", "/v1/decisions/{decision_id}", false));
        assert!(has("POST", "/v1/decisions", true));
        assert!(has("POST", "/v1/decisions/{decision_id}/messages", true));
        assert!(has("POST", "/v1/decisions/{decision_id}/commits", true));
        assert!(has("POST", "/v1/comments", true));
        assert!(has("PUT", "/v1/priority", true));
        assert!(has("POST", "/v1/flows", true));
    }

    #[test]
    fn a_read_only_token_reads_but_cannot_write() {
        let (db, a, ..) = seeded();
        let server = start(&db);
        let token = server.issue_token(a, false).token;
        let token = Some(token.as_str());
        let read = req("GET", "/v1/decisions", token).go(&server);
        assert_eq!(read.status, 200);
        let body = json!({"title":"t","summary":"s"});
        for (method, path) in [
            ("POST", "/v1/decisions"),
            ("POST", "/v1/comments"),
            ("PUT", "/v1/priority"),
            ("POST", "/v1/flows"),
            (
                "POST",
                &format!("/v1/decisions/{}/messages", Uuid::new_v4()),
            ),
            ("POST", &format!("/v1/decisions/{}/commits", Uuid::new_v4())),
        ] {
            let answer = req(method, path, token).with(body.clone()).go(&server);
            assert_eq!(
                (answer.status, code(&answer)),
                (403, "forbidden"),
                "{method} {path}"
            );
        }
        assert!(db.list_decisions(a).unwrap().is_empty());
    }

    #[test]
    fn a_token_is_the_scope_and_a_session_id_naming_another_chat_is_forbidden() {
        let (db, a, b, _) = seeded();
        let server = start(&db);
        let token = server.issue_token(a, true).token;
        let token = Some(token.as_str());
        let other = req("GET", &format!("/v1/decisions?session_id={}", b.0), token).go(&server);
        assert_eq!((other.status, code(&other)), (403, "forbidden"));
        let same = req("GET", &format!("/v1/decisions?session_id={}", a.0), token).go(&server);
        assert_eq!(same.status, 200);
        let body = json!({"title":"t","summary":"s","session_id": b.0.to_string()});
        let posted = req("POST", "/v1/decisions", token).with(body).go(&server);
        assert_eq!((posted.status, code(&posted)), (403, "forbidden"));
        assert!(db.list_decisions(a).unwrap().is_empty());
        let garbled = req("GET", "/v1/decisions?session_id=nope", token).go(&server);
        assert_eq!(garbled.status, 400);
    }

    #[test]
    fn a_body_over_the_limit_is_refused_before_it_is_read() {
        let (db, a, ..) = seeded();
        let server = start(&db);
        let token = server.issue_token(a, true).token;
        let port = server.port();

        // Only the headers promise too much.
        let promised = send(
            port,
            format!(
                "POST /v1/decisions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n",
                MAX_BODY + 1
            )
            .as_bytes(),
        );
        assert_eq!((promised.status, code(&promised)), (413, "too_large"));

        // And a client that does send it all still gets the answer.
        let mut raw = format!(
            "POST /v1/decisions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        )
        .into_bytes();
        raw.extend(std::iter::repeat_n(b'x', MAX_BODY + 1));
        let sent = send(port, &raw);
        assert_eq!((sent.status, code(&sent)), (413, "too_large"));

        // Exactly the limit is taken (and then is not valid JSON, which is another answer).
        let mut at_limit = format!(
            "POST /v1/decisions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Length: {MAX_BODY}\r\n\r\n"
        )
        .into_bytes();
        at_limit.extend(std::iter::repeat_n(b'x', MAX_BODY));
        assert_eq!(send(port, &at_limit).status, 400);

        // The size is judged for callers who are known only.
        let unknown = send(
            port,
            format!(
                "POST /v1/decisions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\n\r\n",
                MAX_BODY + 1
            )
            .as_bytes(),
        );
        assert_eq!(unknown.status, 401);
    }

    #[test]
    fn a_body_that_is_not_a_json_object_is_invalid() {
        let (db, a, ..) = seeded();
        let server = start(&db);
        let token = server.issue_token(a, true).token;
        let port = server.port();
        let post = |body: &str, extra: &str| {
            send(
                port,
                format!(
                    "POST /v1/decisions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n{extra}Content-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
        };
        for body in ["{nope", "[1]", "\"s\"", ""] {
            let answer = post(body, "");
            assert_eq!(answer.status, 400, "{body:?}");
            assert_eq!(code(&answer), "invalid");
        }
        let chunked = post("{}", "Transfer-Encoding: chunked\r\n");
        assert_eq!(chunked.status, 400);
        let garbage = send(port, b"nonsense\r\n\r\n");
        assert_eq!(garbage.status, 400);
    }

    #[test]
    fn decisions_flow_through_the_api_from_the_first_call_to_the_last() {
        let repo = repo_with_a_file();
        let (db, a, _, cp) = seeded_at(repo.clone());
        let server = start(&db);
        let token = server.issue_token(a, true).token;
        let token = Some(token.as_str());

        let created = req("POST", "/v1/decisions", token)
            .with(
                json!({"type":"security","title":"Hash it","summary":"hashed","rationale":"r",
                "files":[{"path":"a.py","start_line":1,"end_line":2}]}),
            )
            .go(&server);
        assert_eq!(created.status, 201, "{}", created.body);
        assert_eq!(created.body["title"], "Hash it");
        assert_eq!(created.body["opened_by"], "agent");
        let id = created.body["id"].as_str().unwrap().to_string();

        let listed = req("GET", "/v1/decisions", token).go(&server);
        assert_eq!(listed.status, 200);
        assert_eq!(listed.body.as_array().unwrap().len(), 1);

        let message = req("POST", &format!("/v1/decisions/{id}/messages"), token)
            .with(json!({"text":"noted"}))
            .go(&server);
        assert_eq!(message.status, 201, "{}", message.body);
        assert_eq!(message.body["author"], "agent");

        let linked = req("POST", &format!("/v1/decisions/{id}/commits"), token)
            .with(json!({"commit":"HEAD","note":"Implements it"}))
            .go(&server);
        assert_eq!(linked.status, 201, "{}", linked.body);
        assert_eq!(linked.body["subject"], "hash the tokens");
        let no_such = req("POST", &format!("/v1/decisions/{id}/commits"), token)
            .with(json!({"commit":"no-such-commit"}))
            .go(&server);
        assert_eq!((no_such.status, code(&no_such)), (404, "not_found"));

        let one = req("GET", &format!("/v1/decisions/{id}"), token).go(&server);
        assert_eq!(one.status, 200);
        assert_eq!(one.body["decision"]["id"], id.as_str());
        assert_eq!(one.body["messages"][0]["text"], "noted");
        let missing = req("GET", &format!("/v1/decisions/{}", Uuid::new_v4()), token).go(&server);
        assert_eq!((missing.status, code(&missing)), (404, "not_found"));
        let not_uuid = req("GET", "/v1/decisions/abc", token).go(&server);
        assert_eq!((not_uuid.status, code(&not_uuid)), (400, "invalid"));
        let incomplete = req("POST", "/v1/decisions", token)
            .with(json!({"title":"only a title"}))
            .go(&server);
        assert_eq!((incomplete.status, code(&incomplete)), (400, "invalid"));

        // Decisions are artifacts too, and the checkpoint can be named.
        let named = req("POST", "/v1/decisions", token)
            .with(json!({"checkpoint_id": cp.0.to_string(), "title":"Two","summary":"s"}))
            .go(&server);
        assert_eq!(named.status, 201);
        assert_eq!(named.body["seq"], 2);
        assert_eq!(db.list_decisions(a).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn comments_priority_and_flows_flow_through_the_api() {
        let repo = repo_with_a_file();
        let (db, a, _, cp) = seeded_at(repo.clone());
        seed_review_queue(&db, a, cp);
        let server = start(&db);
        let token = server.issue_token(a, true).token;
        let token = Some(token.as_str());

        let comment = req("POST", "/v1/comments", token)
            .with(json!({"path":"a.py","unit":"go","text":"Why a constant?"}))
            .go(&server);
        assert_eq!(comment.status, 201, "{}", comment.body);
        assert!(comment.body["done"].is_string());
        assert_eq!(db.list_review_comments(cp).unwrap()[0].author, "agent");

        let set = req("PUT", "/v1/priority", token)
            .with(json!({"path":"a.py","unit":"go","score":90,"reason":"public entry"}))
            .go(&server);
        assert_eq!(set.status, 200, "{}", set.body);
        assert_eq!(db.list_unit_priorities(cp).unwrap()[0].score, 90);
        let too_high = req("PUT", "/v1/priority", token)
            .with(json!({"path":"a.py","unit":"go","score":150}))
            .go(&server);
        assert_eq!((too_high.status, code(&too_high)), (400, "invalid"));
        let reset = req("PUT", "/v1/priority", token)
            .with(json!({"path":"a.py","unit":"go","reset":true}))
            .go(&server);
        assert_eq!(reset.status, 200);
        assert!(db.list_unit_priorities(cp).unwrap().is_empty());

        let flow = req("POST", "/v1/flows", token)
            .with(json!({"name":"Entry","nodes":[
                {"id":"n1","label":"go","kind":"function","refs":[{"path":"a.py","line":1}]}]}))
            .go(&server);
        assert_eq!(flow.status, 201, "{}", flow.body);
        let artifact_id = flow.body["artifact_id"].as_str().unwrap().to_string();

        let listed = req("GET", "/v1/artifacts?kind=flow", token).go(&server);
        assert_eq!(listed.status, 200);
        assert_eq!(listed.body.as_array().unwrap().len(), 1);
        let all = req("GET", "/v1/artifacts", token).go(&server);
        assert_eq!(all.body.as_array().unwrap().len(), 2);
        let one = req("GET", &format!("/v1/artifacts/{artifact_id}"), token).go(&server);
        assert_eq!(one.status, 200);
        assert_eq!(one.body["kind"], "flow");
        let bad_kind = req("GET", "/v1/artifacts?kind=nope", token).go(&server);
        assert_eq!(bad_kind.status, 400);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_revoked_token_stops_working_and_others_keep_working() {
        let (db, a, b, _) = seeded();
        let server = start(&db);
        let first = server.issue_token(a, true);
        let second = server.issue_token(b, false);
        assert_eq!(server.live_tokens(), 2);
        assert_eq!(
            req("GET", "/v1/decisions", Some(&first.token))
                .go(&server)
                .status,
            200
        );
        server.revoke(&first.token);
        assert_eq!(server.live_tokens(), 1);
        let after = req("GET", "/v1/decisions", Some(&first.token)).go(&server);
        assert_eq!((after.status, code(&after)), (401, "unauthorized"));
        assert_eq!(
            req("GET", "/v1/decisions", Some(&second.token))
                .go(&server)
                .status,
            200
        );
        server.revoke("never issued");
        assert_eq!(server.live_tokens(), 1);
    }

    #[test]
    fn the_server_ends_with_its_owner() {
        let (db, ..) = seeded();
        let server = start(&db);
        let port = server.port();
        drop(server);
        // The accept loop wakes up and closes the listener.
        let deadline = Instant::now() + Duration::from_secs(5);
        while TcpStream::connect(("127.0.0.1", port)).is_ok() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }
}
