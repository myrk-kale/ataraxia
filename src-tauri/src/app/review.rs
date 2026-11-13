//! Review priority: which changed files and components deserve attention first.
//!
//! The score is computed from the diff alone (size, sensitive paths, contracts, dependencies,
//! tests, docs), so it is instant, reproducible and every point comes with a reason.

use serde::{Deserialize, Serialize};

use crate::domain::{ChangedFile, FileChange};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Level {
    High,
    Medium,
    Low,
}

impl Level {
    pub fn of(score: u32) -> Self {
        match score {
            60.. => Self::High,
            30..=59 => Self::Medium,
            _ => Self::Low,
        }
    }
}

impl Level {
    /// Units use the thresholds of the scoring model (45 and 20), which is built so that a
    /// plain, contained change stays below the first.
    pub fn of_unit(score: u32) -> Self {
        match score {
            45.. => Self::High,
            20..=44 => Self::Medium,
            _ => Self::Low,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileScore {
    pub path: String,
    pub score: u32,
    pub level: Level,
    pub reasons: Vec<String>,
    pub additions: u32,
    pub deletions: u32,
    pub change: FileChange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentScore {
    pub id: String,
    pub name: String,
    /// Where it lives, when it is one class, impl or file.
    #[serde(default)]
    pub path: Option<String>,
    /// Units of change that belong to it, best first.
    #[serde(default)]
    pub units: Vec<String>,
    pub files: Vec<String>,
    pub score: u32,
    pub level: Level,
    pub additions: u32,
    pub deletions: u32,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnitChange {
    Added,
    Modified,
    Removed,
}

/// The smallest piece of code a change can be attributed to: a function, a method, a type, the
/// top level of a file, or a whole file when there is no grammar for its language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unit {
    pub id: String,
    /// Qualified symbol name (`Repo.create`), or the path for a whole file.
    pub name: String,
    /// `function`, `method`, `class`, ..., `scope` (top level of a file) or `file`.
    pub kind: String,
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    /// `head`, or `base` for a unit that was removed (its lines only exist before).
    pub side: String,
    pub change: UnitChange,
    pub signature_changed: bool,
    pub public: bool,
    /// Other files that mention the name.
    pub references: u32,
    pub additions: u32,
    pub deletions: u32,
    pub score: u32,
    pub level: Level,
    pub reasons: Vec<String>,
    pub container: Option<String>,
    /// Every point of the score with the reason it was given, in the order they were added.
    #[serde(default)]
    pub factors: Vec<ScoreFactor>,
    /// Cyclomatic complexity of the body after the change (0 when it was not measured).
    #[serde(default)]
    pub complexity: u32,
    #[serde(default)]
    pub complexity_before: Option<u32>,
    /// The code is the same once comments and whitespace are ignored.
    #[serde(default)]
    pub format_only: bool,
    /// Risky constructs in the body.
    #[serde(default)]
    pub markers: Vec<UnitMarker>,
    /// `external` (a route, a command, `main`) or `internal` (an exported symbol).
    #[serde(default)]
    pub entry: Option<String>,
    /// The sensitive word its path or name contains (`token`, `payment`).
    #[serde(default)]
    pub sensitive: Option<String>,
    /// Whether a test file mentions it; `None` when that was not looked up.
    #[serde(default)]
    pub tested: Option<bool>,
    /// Other folders whose files mention it.
    #[serde(default)]
    pub dirs: u32,
    /// The file looks machine-generated.
    #[serde(default)]
    pub generated: bool,
}

/// One itemised contribution to a unit's score.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScoreFactor {
    /// `contract`, `reach`, `sensitivity`, `complexity`, `risk`, `tests`, `size` or `mitigation`.
    pub component: String,
    /// Points added; negative for mitigations.
    pub points: i32,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnitMarker {
    pub rule: String,
    pub title: String,
    pub line: u32,
    /// The line is among the lines this change touched.
    pub introduced: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewPriority {
    pub components: Vec<ComponentScore>,
    pub files: Vec<FileScore>,
    #[serde(default)]
    pub units: Vec<Unit>,
    /// Languages a grammar understood in this checkpoint.
    #[serde(default)]
    pub languages: Vec<String>,
}

const SENSITIVE: &[(&str, &str)] = &[
    ("auth", "authentication"),
    ("security", "security"),
    ("crypto", "cryptography"),
    ("secret", "secrets"),
    ("token", "tokens"),
    ("password", "passwords"),
    ("permission", "permissions"),
    ("payment", "payments"),
    ("billing", "billing"),
    ("migration", "database migrations"),
    ("schema", "data schema"),
    ("database", "database access"),
    (".sql", "SQL"),
];

const CONTRACTS: &[&str] = &[
    "/api/",
    "routes",
    "handler",
    "controller",
    ".proto",
    "openapi",
    "swagger",
    ".graphql",
    "/commands",
];

const BUILD_FILES: &[&str] = &[
    "package.json",
    "cargo.toml",
    "go.mod",
    "requirements.txt",
    "pyproject.toml",
    "gemfile",
    "pom.xml",
    "build.gradle",
    "dockerfile",
    ".github/workflows",
    "tauri.conf.json",
];

const LOCKFILES: &[&str] = &[
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "cargo.lock",
    "go.sum",
    "poetry.lock",
    "gemfile.lock",
];

pub fn is_test(lower: &str) -> bool {
    lower.contains("test") || lower.contains("spec.") || lower.contains("__tests__")
}

pub fn score_file(file: &ChangedFile) -> FileScore {
    let lower = file.path.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let mut reasons: Vec<String> = Vec::new();
    let lines = file.additions + file.deletions;

    let mut score: i32;
    if LOCKFILES.contains(&name) {
        reasons.push("generated lockfile".into());
        return finish(file, 3, reasons);
    }
    if file.binary {
        reasons.push("binary file".into());
        return finish(file, 5, reasons);
    }

    score = (((1 + lines) as f64).ln() * 8.0).min(40.0).round() as i32;
    if lines >= 300 {
        score += 10;
        reasons.push(format!("large change ({lines} lines)"));
    } else if lines >= 60 {
        reasons.push(format!("{lines} lines changed"));
    }

    for (needle, label) in SENSITIVE {
        if lower.contains(needle) {
            score += 25;
            reasons.push(format!("touches {label}"));
            break;
        }
    }
    if CONTRACTS.iter().any(|needle| lower.contains(needle)) {
        score += 15;
        reasons.push("public contract or entry point".into());
    }
    if BUILD_FILES.iter().any(|needle| lower.contains(needle)) {
        score += 20;
        reasons.push("dependencies or build configuration".into());
    }
    match file.change {
        FileChange::Deleted => {
            score += 10;
            reasons.push("removes code".into());
        }
        FileChange::Added => {
            score += 5;
            reasons.push("new file".into());
        }
        FileChange::Renamed if lines == 0 => {
            score = score.min(5);
            reasons.push("renamed without edits".into());
        }
        _ => {}
    }
    if is_test(&lower) {
        score -= 15;
        reasons.push("test file".into());
    }
    if lower.ends_with(".md") || lower.starts_with("docs/") {
        score -= 20;
        reasons.push("documentation".into());
    }
    finish(file, score.clamp(0, 100) as u32, reasons)
}

fn finish(file: &ChangedFile, score: u32, mut reasons: Vec<String>) -> FileScore {
    if reasons.is_empty() {
        reasons.push("small, routine change".into());
    }
    FileScore {
        path: file.path.clone(),
        score,
        level: Level::of(score),
        reasons,
        additions: file.additions,
        deletions: file.deletions,
        change: file.change,
    }
}

fn component_key(path: &str) -> String {
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() <= 1 {
        return "(root)".to_string();
    }
    segments[..(segments.len() - 1).min(3)].join("/")
}

pub fn prioritize(files: &[ChangedFile]) -> ReviewPriority {
    let mut scored: Vec<FileScore> = files.iter().map(score_file).collect();
    scored.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));

    let mut components: Vec<ComponentScore> = Vec::new();
    for file in &scored {
        let key = component_key(&file.path);
        match components.iter_mut().find(|component| component.id == key) {
            Some(component) => {
                component.files.push(file.path.clone());
                component.additions += file.additions;
                component.deletions += file.deletions;
            }
            None => components.push(ComponentScore {
                id: key.clone(),
                name: key,
                path: None,
                units: Vec::new(),
                files: vec![file.path.clone()],
                // Files arrive best-first, so the first one explains the component.
                score: file.score,
                level: Level::of(file.score),
                additions: file.additions,
                deletions: file.deletions,
                reasons: file.reasons.iter().take(3).cloned().collect(),
            }),
        }
    }
    for component in components.iter_mut() {
        let extra = (component.files.len().saturating_sub(1) as u32 * 2).min(10);
        component.score = (component.score + extra).min(100);
        component.level = Level::of(component.score);
    }
    components.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.name.cmp(&b.name)));
    ReviewPriority {
        components,
        files: scored,
        units: Vec::new(),
        languages: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, additions: u32, deletions: u32, change: FileChange) -> ChangedFile {
        ChangedFile {
            path: path.into(),
            old_path: None,
            change,
            additions,
            deletions,
            binary: false,
        }
    }

    #[test]
    fn sensitive_and_large_changes_outrank_routine_ones() {
        let result = prioritize(&[
            file("README.md", 4, 1, FileChange::Modified),
            file("src/auth/session.rs", 120, 30, FileChange::Modified),
            file("src/util/format.rs", 6, 2, FileChange::Modified),
            file("pnpm-lock.yaml", 900, 800, FileChange::Modified),
            file("src/auth/session_test.rs", 40, 0, FileChange::Added),
        ]);
        let order: Vec<&str> = result.files.iter().map(|item| item.path.as_str()).collect();
        assert_eq!(order[0], "src/auth/session.rs");
        // Docs and generated lockfiles sit at the bottom, never above real code.
        assert!(
            order.iter().position(|p| *p == "src/util/format.rs")
                < order.iter().position(|p| *p == "pnpm-lock.yaml")
        );
        assert_eq!(*order.last().unwrap(), "README.md");
        assert_eq!(result.files[0].level, Level::High);
        assert!(
            result.files[0]
                .reasons
                .iter()
                .any(|reason| reason.contains("authentication"))
        );

        let readme = result
            .files
            .iter()
            .find(|item| item.path == "README.md")
            .unwrap();
        assert_eq!(readme.level, Level::Low);
        assert_eq!(result.components[0].name, "src/auth");
        assert_eq!(result.components[0].files.len(), 2);
    }

    #[test]
    fn every_file_gets_at_least_one_reason() {
        let result = prioritize(&[file("a/b.txt", 1, 0, FileChange::Modified)]);
        assert!(!result.files[0].reasons.is_empty());
        assert_eq!(result.components[0].name, "a");
        assert_eq!(
            prioritize(&[file("x.txt", 1, 0, FileChange::Added)]).components[0].name,
            "(root)"
        );
    }

    #[test]
    fn deep_paths_group_by_their_first_three_directories() {
        assert_eq!(
            component_key("apps/desktop/src/chat/ChatPanel.tsx"),
            "apps/desktop/src"
        );
        assert_eq!(component_key("Cargo.toml"), "(root)");
    }
}
