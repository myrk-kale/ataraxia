//! A small Language Server Protocol client: starts the servers a repository has installed
//! (pyright, typescript-language-server, rust-analyzer, gopls...), keeps the open file in sync
//! with them and asks them for completions, definitions and diagnostics.
//!
//! Servers are the repository's own programs, so callers start them only for a trusted
//! repository. One server runs per worktree and language; documents are synced whole.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

use crate::app::lint::{Diagnostic, find_executable, tool_path};
use crate::domain::{Error, ErrorCode, Result};

pub const DIAGNOSTICS_EVENT: &str = "lsp://diagnostics";

const START_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_COMPLETIONS: usize = 500;

struct Spec {
    id: &'static str,
    /// Executables to try in order, with the arguments that make them speak LSP on stdio.
    binaries: &'static [(&'static str, &'static [&'static str])],
    local_bins: &'static [&'static str],
    /// Files that say the project is written in this language.
    markers: &'static [&'static str],
    /// File extension and the language id the server expects for it.
    languages: &'static [(&'static str, &'static str)],
}

const SPECS: &[Spec] = &[
    Spec {
        id: "python",
        binaries: &[
            ("pyright-langserver", &["--stdio"]),
            ("basedpyright-langserver", &["--stdio"]),
            ("pylsp", &[]),
            ("jedi-language-server", &[]),
        ],
        local_bins: &[
            ".venv/bin",
            "venv/bin",
            "env/bin",
            ".env/bin",
            "node_modules/.bin",
        ],
        markers: &[
            "pyproject.toml",
            "setup.py",
            "setup.cfg",
            "requirements.txt",
            "Pipfile",
            "pyrightconfig.json",
        ],
        languages: &[("py", "python"), ("pyi", "python")],
    },
    Spec {
        id: "typescript",
        binaries: &[("typescript-language-server", &["--stdio"])],
        local_bins: &["node_modules/.bin"],
        markers: &["tsconfig.json", "jsconfig.json", "package.json"],
        languages: &[
            ("ts", "typescript"),
            ("mts", "typescript"),
            ("cts", "typescript"),
            ("tsx", "typescriptreact"),
            ("js", "javascript"),
            ("mjs", "javascript"),
            ("cjs", "javascript"),
            ("jsx", "javascriptreact"),
        ],
    },
    Spec {
        id: "rust",
        binaries: &[("rust-analyzer", &[])],
        local_bins: &[],
        markers: &["Cargo.toml"],
        languages: &[("rs", "rust")],
    },
    Spec {
        id: "go",
        binaries: &[("gopls", &[])],
        local_bins: &[],
        markers: &["go.mod"],
        languages: &[("go", "go")],
    },
];

/// The server that serves `path` and how to start it, when the repository has one installed.
struct Found {
    spec: &'static Spec,
    program: PathBuf,
    args: &'static [&'static str],
    language_id: &'static str,
}

fn server_for(root: &Path, path: &str) -> Option<Found> {
    let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
    let spec = SPECS
        .iter()
        .find(|spec| spec.languages.iter().any(|(ext, _)| *ext == extension))?;
    let language_id = spec.languages.iter().find(|(ext, _)| *ext == extension)?.1;
    spec.binaries.iter().find_map(|(name, args)| {
        let (program, _) = find_executable(root, name, spec.local_bins)?;
        Some(Found {
            spec,
            program,
            args,
            language_id,
        })
    })
}

/// Language servers installed for the languages this project is written in, by executable name.
pub fn available_servers(root: &Path) -> Vec<String> {
    SPECS
        .iter()
        .filter(|spec| {
            spec.markers
                .iter()
                .any(|marker| root.join(marker).is_file())
        })
        .filter_map(|spec| {
            spec.binaries
                .iter()
                .find(|(name, _)| find_executable(root, name, spec.local_bins).is_some())
                .map(|(name, _)| (*name).to_string())
        })
        .collect()
}

pub fn path_to_uri(path: &Path) -> String {
    let mut out = String::from("file://");
    for byte in path.to_string_lossy().bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

pub fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    Some(PathBuf::from(String::from_utf8(out).ok()?))
}

type Reply = std::result::Result<Value, String>;

struct Server {
    worktree: String,
    root: PathBuf,
    name: String,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, Sender<Reply>>>,
    alive: AtomicBool,
    /// Open documents by relative path: the version last sent and the text it held.
    documents: Mutex<HashMap<String, (i32, String)>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.lock().kill();
    }
}

impl Server {
    fn send(&self, message: &Value) -> Result<()> {
        let body = serde_json::to_vec(message)
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        let mut stdin = self.stdin.lock();
        let result = stdin
            .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
            .and_then(|()| stdin.write_all(&body))
            .and_then(|()| stdin.flush());
        result.map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("the language server stopped: {error}"),
            )
        })
    }

    fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(Error::new(
                ErrorCode::Io,
                "the language server is not running",
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().insert(id, sender);
        if let Err(error) =
            self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
        {
            self.pending.lock().remove(&id);
            return Err(error);
        }
        match receiver.recv_timeout(timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => Err(Error::new(ErrorCode::Io, message)),
            Err(_) => {
                self.pending.lock().remove(&id);
                Err(Error::new(
                    ErrorCode::Io,
                    format!("the language server did not answer {method}"),
                ))
            }
        }
    }

    fn respond(&self, id: &Value, result: Value) {
        let _ = self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    fn relative(&self, uri: &str) -> Option<String> {
        let path = uri_to_path(uri)?;
        Some(
            path.strip_prefix(&self.root)
                .ok()?
                .to_string_lossy()
                .into_owned(),
        )
    }
}

/// Reads messages until the server goes away, answering what it asks of the client.
fn read_loop(server: Arc<Server>, stdout: impl Read, emit: DiagnosticsSink) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut length = None;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    server.alive.store(false, Ordering::SeqCst);
                    server.pending.lock().clear();
                    return;
                }
                Ok(_) => {}
            }
            let line = line.trim();
            if line.is_empty() {
                break;
            }
            if let Some(value) = line.strip_prefix("Content-Length:") {
                length = value.trim().parse::<usize>().ok();
            }
        }
        let Some(length) = length else { continue };
        let mut body = vec![0u8; length];
        if reader.read_exact(&mut body).is_err() {
            server.alive.store(false, Ordering::SeqCst);
            server.pending.lock().clear();
            return;
        }
        let Ok(message) = serde_json::from_slice::<Value>(&body) else {
            continue;
        };
        handle_message(&server, &message, &emit);
    }
}

fn handle_message(server: &Arc<Server>, message: &Value, emit: &DiagnosticsSink) {
    let id = message.get("id");
    let method = message.get("method").and_then(Value::as_str);
    match (id, method) {
        // The answer to one of our requests.
        (Some(id), None) => {
            let Some(id) = id.as_i64() else { return };
            let Some(sender) = server.pending.lock().remove(&id) else {
                return;
            };
            let reply = match message.get("error") {
                Some(error) => Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("error")
                    .to_string()),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = sender.send(reply);
        }
        // A request from the server: answer so it does not wait on us.
        (Some(id), Some(method)) => {
            let result = match method {
                "workspace/configuration" => {
                    let count = message
                        .pointer("/params/items")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                    Value::Array(vec![Value::Null; count])
                }
                "workspace/workspaceFolders" => json!([{
                    "uri": path_to_uri(&server.root),
                    "name": server.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                }]),
                _ => Value::Null,
            };
            server.respond(id, result);
        }
        (None, Some("textDocument/publishDiagnostics")) => {
            publish_diagnostics(server, message, emit)
        }
        _ => {}
    }
}

fn severity_name(value: Option<u64>) -> &'static str {
    match value {
        Some(1) => "error",
        Some(2) => "warning",
        Some(4) => "hint",
        _ => "info",
    }
}

fn position(value: Option<&Value>, key: &str) -> u32 {
    value
        .and_then(|v| v.get(key))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(u32::MAX as u64 - 1) as u32
}

fn convert_diagnostics(server_name: &str, items: &[Value]) -> Vec<Diagnostic> {
    items
        .iter()
        .map(|item| {
            let start = item.pointer("/range/start");
            let end = item.pointer("/range/end");
            let code = item.get("code").map(|code| match code {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            });
            Diagnostic {
                tool: item
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or(server_name)
                    .to_string(),
                line: position(start, "line") + 1,
                column: position(start, "character") + 1,
                end_line: position(end, "line") + 1,
                end_column: position(end, "character") + 1,
                severity: severity_name(item.get("severity").and_then(Value::as_u64)).into(),
                code,
                message: item
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .into(),
            }
        })
        .collect()
}

/// Where what a server publishes goes: to the window, or to a test.
type DiagnosticsSink = Arc<dyn Fn(DiagnosticsEvent) + Send + Sync>;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsEvent {
    worktree_id: String,
    path: String,
    diagnostics: Vec<Diagnostic>,
}

fn publish_diagnostics(server: &Arc<Server>, message: &Value, emit: &DiagnosticsSink) {
    let Some(uri) = message.pointer("/params/uri").and_then(Value::as_str) else {
        return;
    };
    let Some(path) = server.relative(uri) else {
        return;
    };
    let items = message
        .pointer("/params/diagnostics")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let event = DiagnosticsEvent {
        worktree_id: server.worktree.clone(),
        path,
        diagnostics: convert_diagnostics(&server.name, &items),
    };
    emit(event);
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextEditOut {
    /// Zero-based `[start line, start character, end line, end character]`, as the server sent it.
    pub range: [u32; 4],
    pub new_text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompletionEntry {
    pub label: String,
    /// The server's `CompletionItemKind` (1 to 25).
    pub kind: u32,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub insert_text: String,
    pub snippet: bool,
    pub sort_text: Option<String>,
    pub filter_text: Option<String>,
    pub range: Option<[u32; 4]>,
    pub additional_edits: Vec<TextEditOut>,
    pub deprecated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Completions {
    pub items: Vec<CompletionEntry>,
    pub incomplete: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub path: String,
    /// 1-based.
    pub line: u32,
    pub column: u32,
}

fn range_of(value: &Value) -> Option<[u32; 4]> {
    let (start, end) = (value.get("start")?, value.get("end")?);
    Some([
        position(Some(start), "line"),
        position(Some(start), "character"),
        position(Some(end), "line"),
        position(Some(end), "character"),
    ])
}

fn documentation_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        other => other
            .get("value")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn convert_completions(result: &Value) -> Completions {
    let (items, incomplete) = match result {
        Value::Array(items) => (items.clone(), false),
        Value::Object(map) => (
            map.get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            map.get("isIncomplete")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
        _ => (Vec::new(), false),
    };
    let entries = items
        .iter()
        .take(MAX_COMPLETIONS)
        .filter_map(|item| {
            let label = item.get("label")?.as_str()?.to_string();
            let edit = item.get("textEdit");
            // An edit is a range and a text; the "insert or replace" form carries both ranges.
            let range = edit.and_then(|edit| {
                edit.get("range")
                    .or_else(|| edit.get("replace"))
                    .or_else(|| edit.get("insert"))
                    .and_then(range_of)
            });
            let insert_text = edit
                .and_then(|edit| edit.get("newText"))
                .or_else(|| item.get("insertText"))
                .and_then(Value::as_str)
                .unwrap_or(&label)
                .to_string();
            let additional_edits = item
                .get("additionalTextEdits")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|edit| {
                    Some(TextEditOut {
                        range: range_of(edit.get("range")?)?,
                        new_text: edit.get("newText")?.as_str()?.to_string(),
                    })
                })
                .collect();
            Some(CompletionEntry {
                detail: item
                    .get("detail")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                documentation: documentation_text(item.get("documentation")),
                kind: item.get("kind").and_then(Value::as_u64).unwrap_or(1) as u32,
                snippet: item.get("insertTextFormat").and_then(Value::as_u64) == Some(2),
                sort_text: item
                    .get("sortText")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                filter_text: item
                    .get("filterText")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                deprecated: item
                    .get("deprecated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || item
                        .get("tags")
                        .and_then(Value::as_array)
                        .is_some_and(|tags| tags.iter().any(|tag| tag.as_u64() == Some(1))),
                label,
                insert_text,
                range,
                additional_edits,
            })
        })
        .collect();
    Completions {
        items: entries,
        incomplete,
    }
}

/// `Location`, `Location[]` or `LocationLink[]`, as places inside the worktree.
fn convert_places(server: &Server, result: &Value) -> Vec<Place> {
    let list = match result {
        Value::Array(items) => items.clone(),
        Value::Object(_) => vec![result.clone()],
        _ => Vec::new(),
    };
    list.iter()
        .filter_map(|item| {
            let uri = item
                .get("targetUri")
                .or_else(|| item.get("uri"))?
                .as_str()?;
            let range = item
                .get("targetSelectionRange")
                .or_else(|| item.get("range"))
                .or_else(|| item.get("targetRange"))?;
            Some(Place {
                path: server.relative(uri)?,
                line: position(range.get("start"), "line") + 1,
                column: position(range.get("start"), "character") + 1,
            })
        })
        .collect()
}

pub struct LspManager {
    emit: DiagnosticsSink,
    servers: Mutex<HashMap<(String, &'static str), Arc<Server>>>,
    /// Servers that would not start: not tried again until the app restarts.
    failed: Mutex<HashSet<(String, &'static str)>>,
}

impl LspManager {
    pub fn new(app: AppHandle) -> Self {
        let emit: DiagnosticsSink = Arc::new(move |event| {
            if let Err(error) = app.emit(DIAGNOSTICS_EVENT, event) {
                eprintln!("ataraxia: failed to emit diagnostics: {error}");
            }
        });
        Self::with_emitter(emit)
    }

    fn with_emitter(emit: DiagnosticsSink) -> Self {
        Self {
            emit,
            servers: Mutex::new(HashMap::new()),
            failed: Mutex::new(HashSet::new()),
        }
    }

    fn start(&self, worktree: &str, root: &Path, found: &Found) -> Result<Arc<Server>> {
        let mut child = Command::new(&found.program)
            .args(found.args)
            .current_dir(root)
            .env("PATH", tool_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                Error::new(
                    ErrorCode::Io,
                    format!("could not start {}: {error}", found.program.display()),
                )
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::new(ErrorCode::Io, "no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::new(ErrorCode::Io, "no stdout"))?;
        let server = Arc::new(Server {
            worktree: worktree.to_string(),
            root: root.to_path_buf(),
            name: found
                .program
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| found.spec.id.into()),
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
            documents: Mutex::new(HashMap::new()),
        });
        let reader = Arc::clone(&server);
        let emit = Arc::clone(&self.emit);
        std::thread::spawn(move || read_loop(reader, stdout, emit));
        let root_uri = path_to_uri(root);
        server.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "clientInfo": { "name": "Ataraxia" },
                "rootUri": root_uri,
                "workspaceFolders": [{ "uri": root_uri, "name": root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() }],
                "capabilities": {
                    "workspace": { "configuration": true, "workspaceFolders": true },
                    "textDocument": {
                        "synchronization": { "didSave": true },
                        "completion": {
                            "contextSupport": true,
                            "completionItem": {
                                "snippetSupport": true,
                                "documentationFormat": ["markdown", "plaintext"],
                                "deprecatedSupport": true,
                                "tagSupport": { "valueSet": [1] }
                            }
                        },
                        "definition": { "linkSupport": true },
                        "publishDiagnostics": { "relatedInformation": false }
                    }
                }
            }),
            START_TIMEOUT,
        )?;
        server.notify("initialized", json!({}))?;
        Ok(server)
    }

    /// The running server for a file, started on first use. `None` when the repository has no
    /// server for that language, or the one it has would not start.
    fn server(
        &self,
        worktree: &str,
        root: &Path,
        path: &str,
    ) -> Option<(Arc<Server>, &'static str)> {
        let found = server_for(root, path)?;
        let key = (worktree.to_string(), found.spec.id);
        if let Some(server) = self.servers.lock().get(&key) {
            if server.alive.load(Ordering::SeqCst) {
                return Some((Arc::clone(server), found.language_id));
            }
        }
        if self.failed.lock().contains(&key) {
            return None;
        }
        match self.start(worktree, root, &found) {
            Ok(server) => {
                self.servers.lock().insert(key, Arc::clone(&server));
                Some((server, found.language_id))
            }
            Err(error) => {
                eprintln!(
                    "ataraxia: language server for {} did not start: {error}",
                    found.spec.id
                );
                self.failed.lock().insert(key);
                None
            }
        }
    }

    /// Opens a document or sends its new text. Returns the server's name, or `None` without one.
    pub fn sync(&self, worktree: &str, root: &Path, path: &str, text: &str) -> Option<String> {
        let (server, language_id) = self.server(worktree, root, path)?;
        let uri = path_to_uri(&root.join(path));
        let mut documents = server.documents.lock();
        let sent = match documents.get_mut(path) {
            None => {
                documents.insert(path.to_string(), (1, text.to_string()));
                server.notify(
                    "textDocument/didOpen",
                    json!({ "textDocument": { "uri": uri, "languageId": language_id, "version": 1, "text": text } }),
                )
            }
            Some((_, last)) if last == text => Ok(()),
            Some((version, last)) => {
                *version += 1;
                *last = text.to_string();
                server.notify(
                    "textDocument/didChange",
                    json!({ "textDocument": { "uri": uri, "version": *version }, "contentChanges": [{ "text": text }] }),
                )
            }
        };
        drop(documents);
        sent.ok().map(|()| server.name.clone())
    }

    pub fn saved(&self, worktree: &str, root: &Path, path: &str) {
        if let Some((server, _)) = self.server(worktree, root, path) {
            let uri = path_to_uri(&root.join(path));
            let _ = server.notify(
                "textDocument/didSave",
                json!({ "textDocument": { "uri": uri } }),
            );
        }
    }

    pub fn close(&self, worktree: &str, root: &Path, path: &str) {
        let Some(found) = server_for(root, path) else {
            return;
        };
        let server = self
            .servers
            .lock()
            .get(&(worktree.to_string(), found.spec.id))
            .cloned();
        if let Some(server) = server {
            if server.documents.lock().remove(path).is_some() {
                let uri = path_to_uri(&root.join(path));
                let _ = server.notify(
                    "textDocument/didClose",
                    json!({ "textDocument": { "uri": uri } }),
                );
            }
        }
    }

    pub fn complete(
        &self,
        worktree: &str,
        root: &Path,
        path: &str,
        line: u32,
        character: u32,
        trigger: Option<&str>,
    ) -> Result<Completions> {
        let Some((server, _)) = self.server(worktree, root, path) else {
            return Ok(Completions {
                items: Vec::new(),
                incomplete: false,
            });
        };
        let context = match trigger {
            Some(character) => json!({ "triggerKind": 2, "triggerCharacter": character }),
            None => json!({ "triggerKind": 1 }),
        };
        let result = server.request(
            "textDocument/completion",
            json!({
                "textDocument": { "uri": path_to_uri(&root.join(path)) },
                "position": { "line": line, "character": character },
                "context": context,
            }),
            REQUEST_TIMEOUT,
        )?;
        Ok(convert_completions(&result))
    }

    pub fn definition(
        &self,
        worktree: &str,
        root: &Path,
        path: &str,
        line: u32,
        character: u32,
    ) -> Result<Vec<Place>> {
        let Some((server, _)) = self.server(worktree, root, path) else {
            return Ok(Vec::new());
        };
        let result = server.request(
            "textDocument/definition",
            json!({
                "textDocument": { "uri": path_to_uri(&root.join(path)) },
                "position": { "line": line, "character": character },
            }),
            REQUEST_TIMEOUT,
        )?;
        Ok(convert_places(&server, &result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A server that speaks just enough LSP: it answers initialize, publishes one diagnostic when a
    /// document opens, and completes and defines whatever it is asked about.
    const FAKE_SERVER: &str = r#"
import sys, json
def read():
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line: return None
        line = line.decode().strip()
        if not line: break
        if line.lower().startswith("content-length:"): length = int(line.split(":")[1])
    return json.loads(sys.stdin.buffer.read(length))
def send(m):
    body = json.dumps(m).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(body) + body); sys.stdout.buffer.flush()
while True:
    m = read()
    if m is None: break
    method = m.get("method"); i = m.get("id")
    if method == "initialize": send({"jsonrpc":"2.0","id":i,"result":{"capabilities":{}}})
    elif method == "textDocument/didOpen":
        uri = m["params"]["textDocument"]["uri"]
        send({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{"uri":uri,"diagnostics":[{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":3}},"severity":2,"message":"opened"}]}})
    elif method == "textDocument/completion":
        send({"jsonrpc":"2.0","id":i,"result":[{"label":"hello","kind":3}]})
    elif method == "textDocument/definition":
        uri = m["params"]["textDocument"]["uri"]
        send({"jsonrpc":"2.0","id":i,"result":[{"uri":uri,"range":{"start":{"line":4,"character":2},"end":{"line":4,"character":5}}}]})
    elif i is not None: send({"jsonrpc":"2.0","id":i,"result":None})
"#;

    #[test]
    fn talks_to_a_server_over_stdio() {
        let python = find_executable(Path::new("/"), "python3", &[]).map(|(path, _)| path);
        let Some(python) = python else { return };
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake_server.py");
        std::fs::write(&script, FAKE_SERVER).unwrap();
        let args: &'static [&'static str] = Box::leak(
            vec![Box::leak(script.to_string_lossy().into_owned().into_boxed_str()) as &'static str]
                .into_boxed_slice(),
        );
        let (sender, receiver) = mpsc::channel();
        let sender = Mutex::new(sender);
        let manager = LspManager::with_emitter(Arc::new(move |event| {
            let _ = sender.lock().send(event);
        }));
        let found = Found {
            spec: &SPECS[0],
            program: python,
            args,
            language_id: "python",
        };
        let server = manager.start("wt", dir.path(), &found).expect("initialize");
        manager
            .servers
            .lock()
            .insert(("wt".into(), "python"), Arc::clone(&server));

        // The server is found by file type, so the manager reaches it through a python file.
        std::fs::create_dir_all(dir.path().join(".venv/bin")).unwrap();
        let fake = dir.path().join(".venv/bin/pylsp");
        std::fs::write(&fake, "").unwrap();
        let name = manager.sync("wt", dir.path(), "pkg/a.py", "hello = 1\n");
        assert!(name.is_some());
        let event = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("diagnostics");
        assert_eq!(event.path, "pkg/a.py");
        assert_eq!(event.diagnostics[0].message, "opened");
        assert_eq!(event.diagnostics[0].severity, "warning");

        let done = manager
            .complete("wt", dir.path(), "pkg/a.py", 0, 2, None)
            .unwrap();
        assert_eq!(done.items[0].label, "hello");
        let places = manager
            .definition("wt", dir.path(), "pkg/a.py", 0, 2)
            .unwrap();
        assert_eq!(
            places,
            vec![Place {
                path: "pkg/a.py".into(),
                line: 5,
                column: 3
            }]
        );
        manager.close("wt", dir.path(), "pkg/a.py");
        assert!(server.documents.lock().is_empty());
    }

    #[test]
    fn uris_round_trip_with_odd_characters() {
        let path = PathBuf::from("/tmp/my project/ã/a b.py");
        let uri = path_to_uri(&path);
        assert_eq!(uri, "file:///tmp/my%20project/%C3%A3/a%20b.py");
        assert_eq!(uri_to_path(&uri), Some(path));
        assert_eq!(uri_to_path("https://x"), None);
    }

    #[test]
    fn completions_take_the_edit_range_and_text() {
        let result = json!({
            "isIncomplete": true,
            "items": [
                {"label": "append", "kind": 2, "detail": "(object) -> None", "documentation": {"kind": "markdown", "value": "adds"},
                 "textEdit": {"range": {"start": {"line": 3, "character": 2}, "end": {"line": 3, "character": 4}}, "newText": "append($0)"},
                 "insertTextFormat": 2, "sortText": "a", "tags": [1],
                 "additionalTextEdits": [{"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 0}}, "newText": "import x\n"}]},
                {"label": "plain"},
                {"label": "both", "textEdit": {"newText": "both", "insert": {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 1}}, "replace": {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 3}}}},
                {"kind": 3}
            ]
        });
        let out = convert_completions(&result);
        assert!(out.incomplete);
        assert_eq!(out.items.len(), 3);
        let first = &out.items[0];
        assert_eq!(first.range, Some([3, 2, 3, 4]));
        assert_eq!(first.insert_text, "append($0)");
        assert!(first.snippet && first.deprecated);
        assert_eq!(first.documentation.as_deref(), Some("adds"));
        assert_eq!(first.additional_edits.len(), 1);
        assert_eq!(out.items[1].insert_text, "plain");
        assert_eq!(out.items[1].range, None);
        assert_eq!(out.items[2].range, Some([1, 0, 1, 3]));
        assert_eq!(convert_completions(&json!([{"label": "x"}])).items.len(), 1);
        assert!(convert_completions(&Value::Null).items.is_empty());
    }

    #[test]
    fn diagnostics_become_one_based() {
        let items = vec![json!({
            "range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 9}},
            "severity": 1, "code": 2304, "source": "ts", "message": "Cannot find name"
        })];
        let found = convert_diagnostics("server", &items);
        assert_eq!(
            (found[0].line, found[0].column, found[0].end_column),
            (1, 5, 10)
        );
        assert_eq!(found[0].severity, "error");
        assert_eq!(found[0].code.as_deref(), Some("2304"));
        assert_eq!(found[0].tool, "ts");
    }

    #[test]
    fn a_server_is_found_only_for_languages_it_serves() {
        let dir = tempfile::tempdir().unwrap();
        assert!(server_for(dir.path(), "README.md").is_none());
        std::fs::create_dir_all(dir.path().join("node_modules/.bin")).unwrap();
        std::fs::write(
            dir.path()
                .join("node_modules/.bin/typescript-language-server"),
            "",
        )
        .unwrap();
        let found = server_for(dir.path(), "src/App.TSX").unwrap();
        assert_eq!(found.language_id, "typescriptreact");
        assert_eq!(found.spec.id, "typescript");
    }
}
