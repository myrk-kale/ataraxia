//! Semantic review units: what a diff changes, in terms of functions, methods and types.
//!
//! A parser (tree-sitter) finds the symbols of each changed file before and after; every
//! changed line is attributed to the innermost symbol that contains it. Each unit is then scored
//! from facts only (see `heuristics`): contract, reach, sensitive area, complexity, risky
//! constructs, tests, size. No model takes part, so the queue is instant and reproducible.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use crate::domain::{ChangedFile, Checkpoint, FileChange, Hunk, Symbol};
use crate::ports::{Git, Syntax};

use super::heuristics::{entry_of, looks_generated, score_unit, sensitive_word, unit_markers};
use super::review::{
    ComponentScore, FileScore, Level, ReviewPriority, Unit, UnitChange, is_test, prioritize,
};

const MAX_FILES: usize = 80;
const MAX_FILE_BYTES: usize = 400_000;
const MAX_REFERENCE_LOOKUPS: usize = 30;

/// Names too generic for "mentioned in N files" to mean anything.
const COMMON_NAMES: &[&str] = &[
    "new",
    "main",
    "default",
    "from",
    "into",
    "init",
    "run",
    "get",
    "set",
    "test",
    "tests",
    "name",
    "build",
    "create",
    "update",
    "delete",
    "render",
    "handle",
    "drop",
    "clone",
    "fmt",
    "len",
    "next",
    "close",
    "open",
    "read",
    "write",
    "start",
    "stop",
    "self",
    "this",
    "constructor",
    "__init__",
    "setup",
    "teardown",
    "index",
    "mod",
    "lib",
    "app",
    "utils",
    "util",
];

/// Whether a path sits inside a folder whose name starts with a dot (`.github`, `.claude`,
/// `src/.cache`). The component analysis leaves those out: they hold tooling and configuration,
/// not the code under review. A dotfile that is itself the file (`.gitignore`) is not in one.
pub fn in_dot_folder(path: &str) -> bool {
    let mut parts: Vec<&str> = path.split('/').collect();
    parts.pop();
    parts.iter().any(|part| part.starts_with('.'))
}

/// The folder of a repo-relative path.
fn folder(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

/// The innermost symbol (smallest range) that contains `line`.
fn innermost(symbols: &[Symbol], line: u32) -> Option<usize> {
    symbols
        .iter()
        .enumerate()
        .filter(|(_, symbol)| symbol.start_line <= line && line <= symbol.end_line)
        .min_by_key(|(_, symbol)| symbol.end_line - symbol.start_line)
        .map(|(index, _)| index)
}

#[derive(Default)]
struct Draft {
    additions: u32,
    deletions: u32,
}

/// Units of one file, before scoring.
fn file_units(
    file: &ChangedFile,
    base: &[Symbol],
    head: &[Symbol],
    hunks: &[Hunk],
) -> Vec<(Unit, Option<Symbol>)> {
    // Head symbol index -> counts, base symbol index -> counts, loose lines outside symbols.
    let mut touched_head: BTreeMap<usize, Draft> = BTreeMap::new();
    let mut touched_base: BTreeMap<usize, Draft> = BTreeMap::new();
    let mut loose = Draft::default();
    let (mut loose_first, mut loose_last) = (u32::MAX, 0u32);

    for hunk in hunks {
        for line in hunk.new_start..hunk.new_start + hunk.new_len {
            match innermost(head, line) {
                Some(index) => touched_head.entry(index).or_default().additions += 1,
                None => {
                    loose.additions += 1;
                    loose_first = loose_first.min(line);
                    loose_last = loose_last.max(line);
                }
            }
        }
        for line in hunk.old_start..hunk.old_start + hunk.old_len {
            match innermost(base, line) {
                Some(index) => touched_base.entry(index).or_default().deletions += 1,
                None => {
                    loose.deletions += 1;
                    if hunk.new_len == 0 {
                        loose_first = loose_first.min(hunk.new_start.max(1));
                        loose_last = loose_last.max(hunk.new_start.max(1));
                    }
                }
            }
        }
        // A pure deletion leaves no new line: attribute it to where it happened in the head.
        if hunk.new_len == 0 && hunk.old_len > 0 {
            if let Some(index) = innermost(head, hunk.new_start.max(1)) {
                touched_head.entry(index).or_default();
            }
        }
    }

    let head_by_name: HashMap<&str, usize> = head
        .iter()
        .enumerate()
        .map(|(index, symbol)| (symbol.qualified.as_str(), index))
        .collect();
    let base_by_name: HashMap<&str, usize> = base
        .iter()
        .enumerate()
        .map(|(index, symbol)| (symbol.qualified.as_str(), index))
        .collect();

    let mut units: Vec<(Unit, Option<Symbol>)> = Vec::new();
    let mut seen_head: HashSet<usize> = HashSet::new();

    // Deleted lines belong to the same-named head symbol, or to a symbol that is gone.
    let mut deletions_for_head: HashMap<usize, u32> = HashMap::new();
    for (index, draft) in &touched_base {
        let symbol = &base[*index];
        match head_by_name.get(symbol.qualified.as_str()) {
            Some(head_index) => {
                *deletions_for_head.entry(*head_index).or_default() += draft.deletions;
                touched_head.entry(*head_index).or_default();
            }
            None => {
                let whole =
                    draft.deletions >= (symbol.end_line - symbol.start_line + 1).saturating_sub(1);
                units.push((
                    blank_unit(
                        file,
                        symbol,
                        "base",
                        if whole {
                            UnitChange::Removed
                        } else {
                            UnitChange::Modified
                        },
                        0,
                        draft.deletions,
                    ),
                    Some(symbol.clone()),
                ));
            }
        }
    }

    for (index, draft) in &touched_head {
        if !seen_head.insert(*index) {
            continue;
        }
        let symbol = &head[*index];
        let before = base_by_name
            .get(symbol.qualified.as_str())
            .map(|i| &base[*i]);
        let mut unit = blank_unit(
            file,
            symbol,
            "head",
            if before.is_none() {
                UnitChange::Added
            } else {
                UnitChange::Modified
            },
            draft.additions,
            deletions_for_head.get(index).copied().unwrap_or(0) + draft.deletions,
        );
        unit.signature_changed = before.is_some_and(|before| before.signature != symbol.signature);
        attach(&mut unit, symbol, before, hunks);
        units.push((unit, before.cloned()));
    }

    if loose.additions + loose.deletions > 0 {
        let first = if loose_first == u32::MAX {
            1
        } else {
            loose_first
        };
        units.push((
            Unit {
                id: String::new(),
                name: format!(
                    "{} (top level)",
                    file.path.rsplit('/').next().unwrap_or(&file.path)
                ),
                kind: "scope".into(),
                path: file.path.clone(),
                start_line: first,
                end_line: loose_last.max(first),
                side: "head".into(),
                change: if matches!(file.change, FileChange::Added) {
                    UnitChange::Added
                } else {
                    UnitChange::Modified
                },
                signature_changed: false,
                public: false,
                references: 0,
                additions: loose.additions,
                deletions: loose.deletions,
                score: 0,
                level: Level::Low,
                reasons: Vec::new(),
                container: None,
                factors: Vec::new(),
                complexity: 0,
                complexity_before: None,
                format_only: false,
                markers: Vec::new(),
                entry: None,
                sensitive: sensitive_word([file.path.as_str()]),
                tested: None,
                dirs: 0,
                generated: false,
            },
            None,
        ));
    }
    units
}

/// The sensitive word in a symbol's path, name or attributes.
fn sensitivity(path: &str, symbol: &Symbol) -> Option<String> {
    sensitive_word(
        std::iter::once(path)
            .chain(std::iter::once(symbol.qualified.as_str()))
            .chain(symbol.attributes.iter().map(String::as_str)),
    )
}

/// Copies what the parser measured onto the unit that the scoring reads.
fn attach(unit: &mut Unit, symbol: &Symbol, before: Option<&Symbol>, hunks: &[Hunk]) {
    unit.complexity = symbol.complexity;
    unit.complexity_before = before.map(|b| b.complexity).filter(|c| *c > 0);
    unit.format_only = unit.change == UnitChange::Modified
        && before.is_some_and(|b| {
            b.signature == symbol.signature && b.fingerprint == symbol.fingerprint
        });
    unit.markers = unit_markers(&symbol.markers, |line| {
        hunks
            .iter()
            .any(|hunk| line >= hunk.new_start && line < hunk.new_start + hunk.new_len)
    });
    unit.entry = entry_of(symbol, &unit.path);
}

fn blank_unit(
    file: &ChangedFile,
    symbol: &Symbol,
    side: &str,
    change: UnitChange,
    additions: u32,
    deletions: u32,
) -> Unit {
    let mut unit = Unit {
        id: String::new(),
        name: symbol.qualified.clone(),
        kind: symbol.kind.clone(),
        path: file.path.clone(),
        start_line: symbol.start_line,
        end_line: symbol.end_line,
        side: side.into(),
        change,
        signature_changed: false,
        public: symbol.public,
        references: 0,
        additions,
        deletions,
        score: 0,
        level: Level::Low,
        reasons: Vec::new(),
        container: symbol.container.clone(),
        factors: Vec::new(),
        complexity: 0,
        complexity_before: None,
        format_only: false,
        markers: Vec::new(),
        entry: None,
        sensitive: None,
        tested: None,
        dirs: 0,
        generated: false,
    };
    unit.sensitive = sensitivity(&file.path, symbol);
    unit
}

fn file_level_unit(file: &ChangedFile, score: &FileScore) -> Unit {
    Unit {
        id: String::new(),
        name: file.path.clone(),
        kind: "file".into(),
        path: file.path.clone(),
        start_line: 1,
        end_line: 0,
        side: if matches!(file.change, FileChange::Deleted) {
            "base"
        } else {
            "head"
        }
        .into(),
        change: match file.change {
            FileChange::Added => UnitChange::Added,
            FileChange::Deleted => UnitChange::Removed,
            _ => UnitChange::Modified,
        },
        signature_changed: false,
        public: false,
        references: 0,
        additions: file.additions,
        deletions: file.deletions,
        score: score.score,
        level: score.level.clone(),
        reasons: score.reasons.clone(),
        container: None,
        factors: Vec::new(),
        complexity: 0,
        complexity_before: None,
        format_only: false,
        markers: Vec::new(),
        entry: None,
        sensitive: None,
        tested: None,
        dirs: 0,
        generated: false,
    }
}

/// Groups units into components: the class, impl or file that contains them.
pub fn assemble_components(units: &[Unit]) -> Vec<ComponentScore> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<&Unit>> = HashMap::new();
    for unit in units {
        let key = match &unit.container {
            Some(container) => format!("{}::{container}", unit.path),
            None => unit.path.clone(),
        };
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(unit);
    }
    let mut components: Vec<ComponentScore> = order
        .into_iter()
        .map(|key| {
            let mut members = groups.remove(&key).unwrap_or_default();
            members.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.name.cmp(&b.name)));
            let top = members[0];
            let mut files: Vec<String> = Vec::new();
            for member in &members {
                if !files.contains(&member.path) {
                    files.push(member.path.clone());
                }
            }
            let bonus = (members.len().saturating_sub(1) as u32 * 2).min(10);
            let score = (top.score + bonus).min(100);
            let name = match &top.container {
                Some(container) => container.clone(),
                None => top.path.rsplit('/').next().unwrap_or(&top.path).to_string(),
            };
            ComponentScore {
                id: key.clone(),
                name,
                path: Some(top.path.clone()),
                units: members.iter().map(|member| member.id.clone()).collect(),
                files,
                score,
                level: Level::of_unit(score),
                additions: members.iter().map(|member| member.additions).sum(),
                deletions: members.iter().map(|member| member.deletions).sum(),
                reasons: top.reasons.iter().take(3).cloned().collect(),
            }
        })
        .collect();
    components.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.name.cmp(&b.name)));
    components
}

/// Ranks units best-first and (re)assigns stable ids `u1`, `u2`, ... in that order.
pub fn rank_units(units: &mut [Unit]) {
    units.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.start_line.cmp(&b.start_line))
    });
    for (index, unit) in units.iter_mut().enumerate() {
        unit.id = format!("u{}", index + 1);
    }
}

pub fn rebuild(priority: &mut ReviewPriority) {
    rank_units(&mut priority.units);
    priority.components = assemble_components(&priority.units);
}

/// The static review priority of a checkpoint: syntax-aware units, scored from facts only.
pub fn compute(
    git: &dyn Git,
    syntax: &dyn Syntax,
    root: &Path,
    checkpoint: &Checkpoint,
) -> ReviewPriority {
    let mut priority = prioritize(&checkpoint.files);
    let file_scores: HashMap<&str, &FileScore> = priority
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let mut languages: Vec<String> = Vec::new();
    let mut units: Vec<Unit> = Vec::new();

    let ranked: Vec<&ChangedFile> = priority
        .files
        .iter()
        .filter_map(|score| checkpoint.files.iter().find(|file| file.path == score.path))
        .collect();
    // Files in folders that start with a dot never become components (they stay in the changed
    // files and in the project tree).
    let ranked: Vec<&ChangedFile> = ranked
        .into_iter()
        .filter(|file| {
            !in_dot_folder(&file.path) && !file.old_path.as_deref().is_some_and(in_dot_folder)
        })
        .collect();
    for (position, file) in ranked.iter().enumerate() {
        let score = file_scores[file.path.as_str()];
        let language = syntax.language_of(&file.path);
        if position >= MAX_FILES || file.binary || language.is_none() {
            units.push(file_level_unit(file, score));
            continue;
        }
        let base_path = file.old_path.clone().unwrap_or_else(|| file.path.clone());
        let read = |rev: &str, path: &str| -> String {
            git.file_at(root, rev, path)
                .ok()
                .flatten()
                .filter(|text| text.len() <= MAX_FILE_BYTES)
                .unwrap_or_default()
        };
        let base_text = if matches!(file.change, FileChange::Added) {
            String::new()
        } else {
            read(&checkpoint.base_rev, &base_path)
        };
        let head_text = if matches!(file.change, FileChange::Deleted) {
            String::new()
        } else {
            read(&checkpoint.head_rev, &file.path)
        };
        let (Some(base_syms), Some(head_syms)) = (
            syntax.symbols(&base_path, &base_text),
            syntax.symbols(&file.path, &head_text),
        ) else {
            units.push(file_level_unit(file, score));
            continue;
        };
        let mut paths = vec![file.path.clone()];
        if let Some(old) = &file.old_path {
            paths.push(old.clone());
        }
        let hunks = git
            .changed_ranges(root, &checkpoint.base_rev, &checkpoint.head_rev, &paths)
            .unwrap_or_default();
        let produced = file_units(file, &base_syms, &head_syms, &hunks);
        if produced.is_empty() {
            units.push(file_level_unit(file, score));
            continue;
        }
        if let Some(name) = language {
            if !languages.iter().any(|known| known == name) {
                languages.push(name.to_string());
            }
        }
        let generated = looks_generated(&file.path, &head_text);
        units.extend(produced.into_iter().map(|(mut unit, _)| {
            unit.generated = generated;
            unit
        }));
    }

    // Who else uses each change: exported symbols first, then the biggest. One `git grep` each,
    // so only the first few are looked up; the rest are scored without reach and test facts.
    let mut by_size: Vec<usize> = (0..units.len())
        .filter(|index| units[*index].kind != "file" && units[*index].kind != "scope")
        .collect();
    by_size.sort_by_key(|index| {
        (
            std::cmp::Reverse(units[*index].public),
            std::cmp::Reverse(units[*index].additions + units[*index].deletions),
        )
    });
    for index in by_size.into_iter().take(MAX_REFERENCE_LOOKUPS) {
        let name = units[index]
            .name
            .rsplit('.')
            .next()
            .unwrap_or(&units[index].name)
            .to_string();
        if name.len() < 4 || COMMON_NAMES.contains(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        let rev = if units[index].side == "base" {
            &checkpoint.base_rev
        } else {
            &checkpoint.head_rev
        };
        if let Ok(files) = git.files_mentioning(root, rev, &name) {
            let own = units[index].path.clone();
            let own_dir = folder(&own);
            let others: Vec<&String> = files.iter().filter(|path| **path != own).collect();
            let folders: HashSet<&str> = others
                .iter()
                .map(|path| folder(path))
                .filter(|dir| *dir != own_dir)
                .collect();
            units[index].references = others.len() as u32;
            units[index].dirs = folders.len() as u32;
            units[index].tested =
                Some(files.iter().any(|path| is_test(&path.to_ascii_lowercase())));
        }
    }

    for unit in units.iter_mut() {
        if unit.kind != "file" {
            score_unit(unit);
        }
    }
    priority.units = units;
    priority.languages = languages;
    rebuild(&mut priority);
    priority
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::git::GitCli;
    use crate::adapters::syntax::TreeSitterSyntax;
    use crate::domain::ids::{CheckpointId, RepositoryId, SessionId, WorktreeId};
    use crate::domain::{ArtifactStatus, CheckpointSource};
    use std::process::Command;

    fn git(repo: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn checkpoint(repo: &Path, base: &str, head: &str) -> Checkpoint {
        Checkpoint {
            id: CheckpointId::new(),
            session_id: SessionId::new(),
            repository_id: RepositoryId::new(),
            worktree_id: WorktreeId::new(),
            seq: 1,
            base_rev: base.into(),
            head_rev: head.into(),
            source: CheckpointSource::Manual,
            turn_id: None,
            files: GitCli.changed_files(repo, base, head).unwrap(),
            status: ArtifactStatus::Ready,
            created_at: String::new(),
            base_label: None,
            head_label: None,
            head_live: true,
        }
    }

    const BEFORE: &str = "pub struct Repo;\n\nimpl Repo {\n    pub fn create(&self, id: u32) -> u32 {\n        id\n    }\n\n    fn helper(&self) -> u32 {\n        1\n    }\n}\n\npub fn dispatch(job: u32) -> u32 {\n    job\n}\n\nfn untouched() -> u32 {\n    7\n}\n";
    const AFTER: &str = "pub struct Repo;\n\nimpl Repo {\n    pub fn create(&self, id: u32, name: &str) -> u32 {\n        let _ = name;\n        id\n    }\n\n    fn helper(&self) -> u32 {\n        1\n    }\n}\n\npub fn dispatch(job: u32) -> u32 {\n    job\n}\n\nfn untouched() -> u32 {\n    7\n}\n\npub fn brand_new() {}\n";

    #[test]
    fn changes_are_attributed_to_the_function_that_contains_them() {
        let repo = std::env::temp_dir().join(format!("ataraxia-units-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(repo.join("src/auth")).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.email", "t@e.com"]);
        git(&repo, &["config", "user.name", "T"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("src/auth/repo.rs"), BEFORE).unwrap();
        std::fs::write(
            repo.join("src/main.rs"),
            "fn main() { auth::dispatch(1); create_all(); }\n",
        )
        .unwrap();
        std::fs::write(repo.join("notes.txt"), "a\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let base = GitCli.snapshot(&repo, "t/base").unwrap();
        std::fs::write(repo.join("src/auth/repo.rs"), AFTER).unwrap();
        std::fs::write(repo.join("notes.txt"), "a\nb\n").unwrap();
        let head = GitCli.snapshot(&repo, "t/head").unwrap();

        let priority = compute(
            &GitCli,
            &TreeSitterSyntax,
            &repo,
            &checkpoint(&repo, &base, &head),
        );
        let create = priority
            .units
            .iter()
            .find(|unit| unit.name == "Repo.create")
            .expect("create");
        assert_eq!(create.change, UnitChange::Modified);
        assert!(
            create.signature_changed,
            "a new parameter changes the signature"
        );
        assert!(create.public);
        assert!(
            create
                .reasons
                .iter()
                .any(|r| r.contains("declaration of a public method changed"))
        );
        let brand_new = priority
            .units
            .iter()
            .find(|unit| unit.name == "brand_new")
            .expect("added");
        assert_eq!(brand_new.change, UnitChange::Added);
        // Code nobody touched is not a unit.
        for quiet in ["Repo.helper", "dispatch", "untouched"] {
            assert!(
                priority.units.iter().all(|unit| unit.name != quiet),
                "{quiet}"
            );
        }
        // A file with no grammar is one unit for the whole file.
        let notes = priority
            .units
            .iter()
            .find(|unit| unit.path == "notes.txt")
            .expect("notes");
        assert_eq!(notes.kind, "file");
        assert_eq!(priority.languages, vec!["rust".to_string()]);

        // Units are ranked, ids follow the ranking, and components group them by impl.
        assert_eq!(priority.units[0].id, "u1");
        assert!(
            priority
                .units
                .windows(2)
                .all(|pair| pair[0].score >= pair[1].score)
        );
        assert!(
            priority
                .components
                .iter()
                .any(|component| component.name == "Repo" && component.units.len() == 1)
        );
        assert!(
            priority
                .components
                .iter()
                .all(|component| !component.units.is_empty())
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_removed_function_is_a_unit_on_the_old_side_and_impact_counts_other_files() {
        let repo = std::env::temp_dir().join(format!("ataraxia-units-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.email", "t@e.com"]);
        git(&repo, &["config", "user.name", "T"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(
            repo.join("lib.py"),
            "def keep():\n    return 1\n\n\ndef publish_report(x):\n    return x + 1\n",
        )
        .unwrap();
        std::fs::write(
            repo.join("a.py"),
            "from lib import publish_report\npublish_report(1)\n",
        )
        .unwrap();
        std::fs::write(repo.join("b.py"), "import lib\nlib.publish_report(2)\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let base = GitCli.snapshot(&repo, "t/base").unwrap();
        std::fs::write(repo.join("lib.py"), "def keep():\n    return 1\n").unwrap();
        let head = GitCli.snapshot(&repo, "t/head").unwrap();

        let priority = compute(
            &GitCli,
            &TreeSitterSyntax,
            &repo,
            &checkpoint(&repo, &base, &head),
        );
        let removed = priority
            .units
            .iter()
            .find(|unit| unit.name == "publish_report")
            .expect("removed");
        assert_eq!(removed.change, UnitChange::Removed);
        assert_eq!(removed.side, "base");
        // The callers still exist, and will break: they are counted where the function used to be.
        assert_eq!(removed.references, 2);
        assert!(
            removed
                .factors
                .iter()
                .any(|f| f.component == "contract"
                    && f.reason.contains("public function was removed")),
            "{:?}",
            removed.factors
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn units_are_scored_from_what_the_parser_and_git_know() {
        let repo = std::env::temp_dir().join(format!("ataraxia-score-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(repo.join("web")).unwrap();
        std::fs::create_dir_all(repo.join("cli")).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.email", "a@b.c"]);
        git(&repo, &["config", "user.name", "t"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(
            repo.join("lib.py"),
            "def fetch(cur):\n    return cur.fetchone()\n\n\ndef tidy(x):\n    return x + 1\n",
        )
        .unwrap();
        std::fs::write(repo.join("web/a.py"), "from lib import fetch\nfetch(1)\n").unwrap();
        std::fs::write(repo.join("cli/b.py"), "import lib\nlib.fetch(2)\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let base = GitCli.snapshot(&repo, "t/base").unwrap();
        std::fs::write(
            repo.join("lib.py"),
            "def fetch(cur, user):\n    cur.execute(\"select * from t where u = \" + user)\n    return cur.fetchone()\n\n\ndef tidy(x):\n    # add one\n    return x  +  1\n",
        )
        .unwrap();
        let head = GitCli.snapshot(&repo, "t/head").unwrap();

        let priority = compute(
            &GitCli,
            &TreeSitterSyntax,
            &repo,
            &checkpoint(&repo, &base, &head),
        );
        let by_name = |name: &str| {
            priority
                .units
                .iter()
                .find(|unit| unit.name == name)
                .unwrap_or_else(|| {
                    panic!(
                        "{name} in {:?}",
                        priority.units.iter().map(|u| &u.name).collect::<Vec<_>>()
                    )
                })
        };
        let fetch = by_name("fetch");
        let tidy = by_name("tidy");

        assert_eq!(
            priority.units[0].name, "fetch",
            "the risky public change comes first"
        );
        assert_eq!(fetch.level, Level::High);
        let components: Vec<&str> = fetch.factors.iter().map(|f| f.component.as_str()).collect();
        for expected in ["contract", "reach", "risk", "tests"] {
            assert!(
                components.contains(&expected),
                "{expected} in {:?}",
                fetch.factors
            );
        }
        assert!(
            fetch
                .markers
                .iter()
                .any(|m| m.rule == "sql_from_dynamic_text" && m.introduced)
        );
        assert_eq!(fetch.dirs, 2);
        assert_eq!(fetch.tested, Some(false));
        let total: i32 = fetch.factors.iter().map(|f| f.points).sum();
        assert_eq!(i32::try_from(fetch.score).unwrap(), total.clamp(0, 100));

        assert!(tidy.format_only, "only a comment and spaces changed");
        assert_eq!(tidy.level, Level::Low);
        assert!(
            tidy.reasons
                .iter()
                .any(|r| r.contains("whitespace or comments"))
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn folders_that_start_with_a_dot_are_left_out_of_the_components() {
        assert!(in_dot_folder(".github/workflows/ci.yml"));
        assert!(in_dot_folder("src/.cache/index.ts"));
        assert!(in_dot_folder(".claude/skills/a/SKILL.md"));
        assert!(!in_dot_folder(".gitignore"));
        assert!(!in_dot_folder("src/app.rs"));
        assert!(!in_dot_folder("docs/a.b/readme.md"));

        let repo = std::env::temp_dir().join(format!("ataraxia-dots-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(repo.join(".tooling")).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.email", "a@b.c"]);
        git(&repo, &["config", "user.name", "t"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("app.py"), "def run():\n    return 1\n").unwrap();
        std::fs::write(repo.join(".tooling/hook.py"), "def hook():\n    return 1\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "x\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let base = GitCli.snapshot(&repo, "t/base").unwrap();
        std::fs::write(repo.join("app.py"), "def run():\n    return 2\n").unwrap();
        std::fs::write(repo.join(".tooling/hook.py"), "def hook():\n    return 2\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "x\ny\n").unwrap();
        let head = GitCli.snapshot(&repo, "t/head").unwrap();
        let checkpoint = checkpoint(&repo, &base, &head);
        assert_eq!(checkpoint.files.len(), 3, "all three changed");

        let priority = compute(&GitCli, &TreeSitterSyntax, &repo, &checkpoint);
        let paths: Vec<&str> = priority
            .units
            .iter()
            .map(|unit| unit.path.as_str())
            .collect();
        assert!(
            paths.contains(&"app.py") && paths.contains(&".gitignore"),
            "{paths:?}"
        );
        assert!(
            !paths.iter().any(|path| path.starts_with(".tooling")),
            "{paths:?}"
        );
        assert!(
            priority
                .components
                .iter()
                .all(|c| !c.files.iter().any(|f| f.starts_with(".tooling")))
        );
        let _ = std::fs::remove_dir_all(&repo);
    }
}
