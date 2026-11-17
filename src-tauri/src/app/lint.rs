//! Linters and type checkers of the repository, run on a file and read back as diagnostics.
//!
//! What a repository uses is found from its own files: a tool counts when its config is there or
//! when its executable lives in the project (`.venv/bin`, `node_modules/.bin`). Running them
//! executes programs the repository chose, so nothing runs until the user trusted that repository.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::engine::Engine;
use crate::domain::ids::{RepositoryId, WorktreeId};
use crate::domain::{Error, ErrorCode, Result};

const RUN_TIMEOUT: Duration = Duration::from_secs(40);
const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const MAX_DIAGNOSTICS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tool {
    Ruff,
    Mypy,
    Flake8,
    Eslint,
    Biome,
}

const TOOLS: [Tool; 5] = [
    Tool::Ruff,
    Tool::Mypy,
    Tool::Flake8,
    Tool::Eslint,
    Tool::Biome,
];

impl Tool {
    fn id(self) -> &'static str {
        match self {
            Self::Ruff => "ruff",
            Self::Mypy => "mypy",
            Self::Flake8 => "flake8",
            Self::Eslint => "eslint",
            Self::Biome => "biome",
        }
    }

    fn is_python(self) -> bool {
        matches!(self, Self::Ruff | Self::Mypy | Self::Flake8)
    }

    fn handles(self, path: &str) -> bool {
        let extension = path
            .rsplit_once('.')
            .map(|(_, ext)| ext.to_ascii_lowercase())
            .unwrap_or_default();
        let python = matches!(extension.as_str(), "py" | "pyi");
        let script = matches!(
            extension.as_str(),
            "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts"
        );
        match self {
            Self::Ruff | Self::Mypy | Self::Flake8 => python,
            Self::Eslint => script || matches!(extension.as_str(), "vue" | "svelte"),
            Self::Biome => script || matches!(extension.as_str(), "json" | "jsonc" | "css"),
        }
    }

    /// Folders of the project where this tool's executable would be installed.
    fn local_bins(self) -> &'static [&'static str] {
        if self.is_python() {
            &[".venv/bin", "venv/bin", "env/bin", ".env/bin"]
        } else {
            &["node_modules/.bin"]
        }
    }

    fn has_config(self, root: &Path) -> bool {
        let has = |name: &str| root.join(name).is_file();
        let mentions = |file: &str, needle: &str| {
            std::fs::read_to_string(root.join(file))
                .map(|text| text.contains(needle))
                .unwrap_or(false)
        };
        match self {
            Self::Ruff => {
                has("ruff.toml") || has(".ruff.toml") || mentions("pyproject.toml", "[tool.ruff")
            }
            Self::Mypy => {
                has("mypy.ini")
                    || has(".mypy.ini")
                    || mentions("pyproject.toml", "[tool.mypy")
                    || mentions("setup.cfg", "[mypy")
                    || mentions("tox.ini", "[mypy")
            }
            Self::Flake8 => {
                has(".flake8") || mentions("setup.cfg", "[flake8") || mentions("tox.ini", "[flake8")
            }
            Self::Eslint => {
                [
                    "eslint.config.js",
                    "eslint.config.mjs",
                    "eslint.config.cjs",
                    "eslint.config.ts",
                    ".eslintrc",
                    ".eslintrc.js",
                    ".eslintrc.cjs",
                    ".eslintrc.json",
                    ".eslintrc.yml",
                    ".eslintrc.yaml",
                ]
                .iter()
                .any(|name| has(name))
                    || mentions("package.json", "\"eslintConfig\"")
            }
            Self::Biome => has("biome.json") || has("biome.jsonc"),
        }
    }

    /// The executable to run, preferring the project's own over the one on `PATH`.
    fn executable(self, root: &Path) -> Option<(PathBuf, bool)> {
        find_executable(root, self.id(), self.local_bins())
    }

    fn command(self, relative: &str) -> Vec<String> {
        let list = |items: &[&str]| {
            items
                .iter()
                .map(|item| item.to_string())
                .collect::<Vec<_>>()
        };
        let mut args = match self {
            Self::Ruff => list(&[
                "check",
                "--output-format",
                "json",
                "--no-fix",
                "--no-cache",
                "--",
            ]),
            Self::Mypy => list(&[
                "--show-column-numbers",
                "--show-error-codes",
                "--no-error-summary",
                "--no-pretty",
                "--hide-error-context",
                "--no-color-output",
                "--",
            ]),
            Self::Flake8 => list(&["--format=%(row)d:%(col)d:%(code)s:%(text)s", "--"]),
            Self::Eslint => list(&["--format", "json", "--no-warn-ignored", "--"]),
            Self::Biome => list(&["lint", "--reporter=github", "--colors=off", "--"]),
        };
        args.push(relative.to_string());
        args
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LintToolInfo {
    pub id: String,
    /// Where the executable was found: the project's own, or the one on `PATH`.
    pub local: bool,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LintStatus {
    pub trusted: bool,
    pub tools: Vec<LintToolInfo>,
    /// Language servers the project could use; filled in by the adapter that knows them.
    #[serde(default)]
    pub servers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub tool: String,
    /// 1-based.
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    /// `error`, `warning`, `info` or `hint`.
    pub severity: String,
    pub code: Option<String>,
    pub message: String,
}

/// Folders a desktop app misses on `PATH` (it does not get the shell's) where tools are installed.
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/go/bin"]
        .iter()
        .map(PathBuf::from)
        .collect();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for sub in [
            ".cargo/bin",
            ".local/bin",
            "go/bin",
            ".volta/bin",
            ".bun/bin",
        ] {
            dirs.push(home.join(sub));
        }
    }
    dirs
}

/// `PATH` as the tools should see it: the app's own, then the usual install folders. Language
/// servers written in Node or Python start other programs through it.
pub(crate) fn tool_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    for dir in extra_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// An executable called `name`: from the project's own folders first (`true` then), else from
/// `PATH` and the usual install folders.
pub(crate) fn find_executable(
    root: &Path,
    name: &str,
    local_bins: &[&str],
) -> Option<(PathBuf, bool)> {
    for dir in local_bins {
        let candidate = root.join(dir).join(name);
        if candidate.is_file() {
            return Some((candidate, true));
        }
    }
    std::env::split_paths(&tool_path())
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
        .map(|found| (found, false))
}

/// Tools the repository uses and can run: configured or installed in the project, with an
/// executable found.
fn detect(root: &Path) -> Vec<(Tool, PathBuf, bool)> {
    TOOLS
        .iter()
        .filter_map(|tool| {
            let (path, local) = tool.executable(root)?;
            (local || tool.has_config(root)).then_some((*tool, path, local))
        })
        .collect()
}

/// A path inside the worktree, as git writes it: no absolute path, no `..`.
pub(crate) fn safe_relative(path: &str) -> Result<&str> {
    let bad = path.is_empty()
        || path.starts_with('/')
        || path.starts_with('-')
        || path.contains('\0')
        || path.split(['/', '\\']).any(|part| part == "..");
    if bad {
        return Err(Error::new(
            ErrorCode::Invalid,
            "not a path inside the worktree",
        ));
    }
    Ok(path)
}

fn run(program: &Path, args: &[String], cwd: &Path) -> Result<(String, String)> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env("NO_COLOR", "1")
        .env("PATH", tool_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("could not start {}: {error}", program.display()),
            )
        })?;
    let read = |stream: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(stream) = stream {
                let _ = stream.take(MAX_OUTPUT as u64).read_to_end(&mut buffer);
            }
            String::from_utf8_lossy(&buffer).into_owned()
        })
    };
    let stdout = read(
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let stderr = read(
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > RUN_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::new(
                    ErrorCode::Io,
                    "the check took too long and was stopped",
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(Error::new(ErrorCode::Io, error.to_string())),
        }
    }
    Ok((
        stdout.join().unwrap_or_default(),
        stderr.join().unwrap_or_default(),
    ))
}

fn number(value: Option<&Value>) -> u32 {
    value
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32
}

fn parse_ruff(output: &str) -> Option<Vec<Diagnostic>> {
    let items: Vec<Value> = serde_json::from_str(output).ok()?;
    Some(
        items
            .iter()
            .map(|item| {
                let code = item.get("code").and_then(Value::as_str).map(str::to_string);
                let line = number(item.pointer("/location/row")).max(1);
                let column = number(item.pointer("/location/column")).max(1);
                Diagnostic {
                    tool: "ruff".into(),
                    line,
                    column,
                    end_line: number(item.pointer("/end_location/row")).max(line),
                    end_column: number(item.pointer("/end_location/column")).max(1),
                    // Ruff has no levels; a finding without a rule code is a syntax error.
                    severity: if code.is_some() { "warning" } else { "error" }.into(),
                    code,
                    message: item
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                }
            })
            .collect(),
    )
}

fn parse_eslint(output: &str) -> Option<Vec<Diagnostic>> {
    let files: Vec<Value> = serde_json::from_str(output).ok()?;
    let mut out = Vec::new();
    for file in &files {
        for message in file
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let line = number(message.get("line")).max(1);
            let column = number(message.get("column")).max(1);
            out.push(Diagnostic {
                tool: "eslint".into(),
                line,
                column,
                end_line: number(message.get("endLine")).max(line),
                end_column: number(message.get("endColumn")).max(column + 1),
                severity: if number(message.get("severity")) >= 2 {
                    "error"
                } else {
                    "warning"
                }
                .into(),
                code: message
                    .get("ruleId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                message: message
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .into(),
            });
        }
    }
    Some(out)
}

/// `path:line:col: error: text  [code]`, mypy's one-line form.
fn parse_mypy(output: &str, relative: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for raw in output.lines() {
        let mut parts = raw.splitn(5, ':');
        let (Some(file), Some(line), Some(column), Some(level), Some(rest)) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            continue;
        };
        let (Ok(line), Ok(column)) = (line.trim().parse::<u32>(), column.trim().parse::<u32>())
        else {
            continue;
        };
        if file.trim_start_matches("./") != relative {
            continue;
        }
        let severity = match level.trim() {
            "error" => "error",
            "warning" => "warning",
            _ => "info",
        };
        let text = rest.trim();
        let (message, code) = match text.rsplit_once("  [") {
            Some((message, code)) if code.ends_with(']') => {
                (message.trim(), Some(code.trim_end_matches(']').to_string()))
            }
            _ => (text, None),
        };
        out.push(Diagnostic {
            tool: "mypy".into(),
            line: line.max(1),
            column: column.max(1),
            end_line: line.max(1),
            end_column: column.max(1) + 1,
            severity: severity.into(),
            code,
            message: message.into(),
        });
    }
    out
}

/// `row:col:CODE:text`, from the format the command asks flake8 for.
fn parse_flake8(output: &str) -> Vec<Diagnostic> {
    output
        .lines()
        .filter_map(|raw| {
            let mut parts = raw.splitn(4, ':');
            let line = parts.next()?.trim().parse::<u32>().ok()?.max(1);
            let column = parts.next()?.trim().parse::<u32>().ok()?.max(1);
            let code = parts.next()?.trim().to_string();
            let message = parts.next()?.trim().to_string();
            // E9xx are syntax errors and F82x undefined names; the rest are style or hygiene.
            let severity = if code.starts_with("E9") || code.starts_with("F82") {
                "error"
            } else {
                "warning"
            };
            Some(Diagnostic {
                tool: "flake8".into(),
                line,
                column,
                end_line: line,
                end_column: column + 1,
                severity: severity.into(),
                code: Some(code),
                message,
            })
        })
        .collect()
}

/// GitHub annotations: `::error title=rule,file=f,line=1,endLine=1,col=2,endColumn=5::message`.
fn parse_biome(output: &str) -> Vec<Diagnostic> {
    output
        .lines()
        .filter_map(|raw| {
            let rest = raw.strip_prefix("::")?;
            let (head, message) = rest.split_once("::")?;
            let (level, props) = head.split_once(' ')?;
            let severity = match level {
                "error" => "error",
                "warning" => "warning",
                _ => "info",
            };
            let prop = |name: &str| {
                props
                    .split(',')
                    .find_map(|pair| pair.strip_prefix(name)?.strip_prefix('='))
            };
            let line = prop("line")?.parse::<u32>().ok()?.max(1);
            let column = prop("col")
                .and_then(|v| v.parse().ok())
                .unwrap_or(1u32)
                .max(1);
            Some(Diagnostic {
                tool: "biome".into(),
                line,
                column,
                end_line: prop("endLine")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(line)
                    .max(line),
                end_column: prop("endColumn")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(column + 1),
                severity: severity.into(),
                code: prop("title").map(str::to_string),
                message: message.trim().to_string(),
            })
        })
        .collect()
}

fn trust_key(repository: RepositoryId) -> String {
    format!("lint-trust/{}", repository.0)
}

impl Engine {
    fn worktree_for_lint(&self, worktree_id: WorktreeId) -> Result<crate::domain::Worktree> {
        self.db
            .get_worktree(worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))
    }

    /// The folder of a worktree whose tools the user allowed to run; the guard of everything that
    /// starts a program the repository chose.
    pub(crate) fn lint_trusted_root(&self, worktree_id: WorktreeId) -> Result<PathBuf> {
        let worktree = self.worktree_for_lint(worktree_id)?;
        if self
            .db
            .get_preference(&trust_key(worktree.repository_id))?
            .as_deref()
            != Some("1")
        {
            return Err(Error::new(
                ErrorCode::Invalid,
                "running this repository's tools is not allowed yet",
            ));
        }
        Ok(worktree.path)
    }

    /// The tools this repository uses, and whether the user allowed running them.
    pub fn code_lint_status(&self, worktree_id: WorktreeId) -> Result<LintStatus> {
        let worktree = self.worktree_for_lint(worktree_id)?;
        let trusted = self
            .db
            .get_preference(&trust_key(worktree.repository_id))?
            .as_deref()
            == Some("1");
        let tools = detect(&worktree.path)
            .into_iter()
            .map(|(tool, path, local)| LintToolInfo {
                id: tool.id().into(),
                local,
                path: path.to_string_lossy().into_owned(),
            })
            .collect();
        Ok(LintStatus {
            trusted,
            tools,
            servers: Vec::new(),
        })
    }

    pub fn code_lint_trust(&self, worktree_id: WorktreeId, trusted: bool) -> Result<()> {
        let worktree = self.worktree_for_lint(worktree_id)?;
        self.db.set_preference(
            &trust_key(worktree.repository_id),
            if trusted { "1" } else { "" },
        )
    }

    /// Runs every tool of the repository that handles `path` and gathers what they report. A
    /// tool that fails to run is skipped when another one answered, and is the error otherwise.
    pub fn code_lint_file(&self, worktree_id: WorktreeId, path: &str) -> Result<Vec<Diagnostic>> {
        let relative = safe_relative(path)?;
        let worktree = self.worktree_for_lint(worktree_id)?;
        if self
            .db
            .get_preference(&trust_key(worktree.repository_id))?
            .as_deref()
            != Some("1")
        {
            return Err(Error::new(
                ErrorCode::Invalid,
                "running this repository's tools is not allowed yet",
            ));
        }
        let mut all = Vec::new();
        let mut failure = None;
        let mut answered = false;
        for (tool, program, _) in detect(&worktree.path) {
            if !tool.handles(relative) {
                continue;
            }
            match run(&program, &tool.command(relative), &worktree.path) {
                Ok((stdout, stderr)) => {
                    let parsed = match tool {
                        Tool::Ruff => parse_ruff(&stdout),
                        Tool::Eslint => parse_eslint(&stdout),
                        Tool::Mypy => Some(parse_mypy(&stdout, relative)),
                        Tool::Flake8 => Some(parse_flake8(&stdout)),
                        Tool::Biome => Some(parse_biome(&stdout)),
                    };
                    match parsed {
                        Some(found) => {
                            answered = true;
                            all.extend(found);
                        }
                        None => {
                            let detail = stderr.trim();
                            failure = Some(format!(
                                "{} gave no readable answer{}",
                                tool.id(),
                                if detail.is_empty() {
                                    String::new()
                                } else {
                                    format!(": {}", detail.lines().next().unwrap_or(""))
                                }
                            ));
                        }
                    }
                }
                Err(error) => failure = Some(format!("{}: {}", tool.id(), error.message)),
            }
        }
        if !answered {
            if let Some(message) = failure {
                return Err(Error::new(ErrorCode::Io, message));
            }
        }
        all.sort_by_key(|item| (item.line, item.column));
        all.truncate(MAX_DIAGNOSTICS);
        Ok(all)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ruff_json() {
        let out = r#"[{"code":"F401","message":"`os` imported but unused","location":{"row":1,"column":8},"end_location":{"row":1,"column":10},"filename":"a.py"},
                      {"code":null,"message":"SyntaxError: x","location":{"row":3,"column":1},"end_location":{"row":3,"column":2}}]"#;
        let found = parse_ruff(out).unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(
            (found[0].line, found[0].column, found[0].end_column),
            (1, 8, 10)
        );
        assert_eq!(found[0].severity, "warning");
        assert_eq!(found[0].code.as_deref(), Some("F401"));
        assert_eq!(found[1].severity, "error");
        assert!(parse_ruff("Traceback...").is_none());
    }

    #[test]
    fn reads_eslint_json() {
        let out = r#"[{"filePath":"/x/a.ts","messages":[{"ruleId":"no-undef","severity":2,"message":"'x' is not defined.","line":4,"column":3,"endLine":4,"endColumn":4},{"ruleId":null,"severity":2,"message":"Parsing error","line":9,"column":1}]}]"#;
        let found = parse_eslint(out).unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].severity, "error");
        assert_eq!(found[0].code.as_deref(), Some("no-undef"));
        assert_eq!(found[1].code, None);
        assert!(found[1].end_column > found[1].column);
    }

    #[test]
    fn reads_mypy_lines_of_the_file_only() {
        let out = "pkg/a.py:3:5: error: Incompatible types in assignment  [assignment]\n\
                   pkg/other.py:1:1: error: nope  [misc]\n\
                   pkg/a.py:3:5: note: See docs\n\
                   Found 2 errors\n";
        let found = parse_mypy(out, "pkg/a.py");
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].code.as_deref(), Some("assignment"));
        assert_eq!(found[0].message, "Incompatible types in assignment");
        assert_eq!(found[1].severity, "info");
    }

    #[test]
    fn reads_flake8_and_biome() {
        let found =
            parse_flake8("1:1:E902:TokenError: x\n5:80:E501:line too long (90 > 79 characters)\n");
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].severity, "error");
        assert_eq!(found[1].message, "line too long (90 > 79 characters)");
        let biome = parse_biome(
            "::error title=lint/suspicious/noDoubleEquals,file=a.js,line=2,endLine=2,col=5,endColumn=7::Use === instead of ==.\n",
        );
        assert_eq!(biome.len(), 1);
        assert_eq!(
            (biome[0].line, biome[0].column, biome[0].end_column),
            (2, 5, 7)
        );
        assert_eq!(
            biome[0].code.as_deref(),
            Some("lint/suspicious/noDoubleEquals")
        );
    }

    #[test]
    fn paths_that_leave_the_worktree_are_refused() {
        assert!(safe_relative("src/a.py").is_ok());
        for bad in ["", "/etc/passwd", "../a.py", "a/../../b.py", "-rf", "a\0b"] {
            assert!(safe_relative(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_tool_counts_only_when_the_repository_uses_it() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            detect(dir.path())
                .iter()
                .all(|(tool, _, local)| !*local && tool.has_config(dir.path()))
        );
        std::fs::create_dir_all(dir.path().join(".venv/bin")).unwrap();
        std::fs::write(dir.path().join(".venv/bin/ruff"), "").unwrap();
        let found = detect(dir.path());
        assert!(
            found
                .iter()
                .any(|(tool, _, local)| *tool == Tool::Ruff && *local)
        );
    }
}
