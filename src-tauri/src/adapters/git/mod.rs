//! Git CLI adapter.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::domain::{
    BranchInfo, ChangedFile, CommitInfo, Error, ErrorCode, FileChange, GitRefs, Hunk, RefInfo,
    RepoInfo, Result, WorktreeInfo,
};
use crate::ports::{FilesProbe, Git};

mod probe;

#[derive(Debug, Default, Clone, Copy)]
pub struct GitCli;

impl Git for GitCli {
    fn discover(&self, path: &Path) -> Result<RepoInfo> {
        let root = git_output(&["rev-parse", "--show-toplevel"], Some(path))?;
        let root = PathBuf::from(root.trim());
        let name = root
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| root.display().to_string());
        Ok(RepoInfo { root, name })
    }

    fn list_worktrees(&self, repo_root: &Path) -> Result<Vec<WorktreeInfo>> {
        let porcelain = git_output(&["worktree", "list", "--porcelain"], Some(repo_root))?;
        parse_worktree_porcelain(&porcelain)
    }

    fn head_marker(&self, worktree: &Path) -> Result<String> {
        probe::head_marker(worktree)
    }

    fn files_probe(&self, worktree: &Path) -> Result<FilesProbe> {
        probe::files_probe(worktree)
    }

    fn status_stamp(&self, worktree: &Path) -> Result<String> {
        probe::status_stamp(worktree)
    }

    fn list_branches(&self, worktree: &Path) -> Result<Vec<BranchInfo>> {
        let listing = git_output(
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname:short)%09%(HEAD)%09%(worktreepath)",
                "refs/heads",
            ],
            Some(worktree),
        )?;
        Ok(listing
            .lines()
            .filter_map(|line| {
                let mut parts = line.splitn(3, '\t');
                let name = parts.next()?.trim();
                let head = parts.next()?.trim();
                let elsewhere = parts.next().unwrap_or_default().trim();
                (!name.is_empty()).then(|| BranchInfo {
                    name: name.to_string(),
                    current: head == "*",
                    worktree_path: (head != "*" && !elsewhere.is_empty())
                        .then(|| PathBuf::from(elsewhere)),
                })
            })
            .collect())
    }

    fn switch_branch(&self, worktree: &Path, name: &str) -> Result<()> {
        validate_spec(name)?;
        // `checkout`, not `switch`: `switch` refuses while any operation is recorded as pending
        // (a revert or cherry-pick that was stopped, leaving its marker behind) even when nothing
        // stands in the way, and `checkout` does what the person would do in a terminal. It still
        // refuses what really stands in the way (local edits it would overwrite, unmerged paths).
        // `--no-guess` keeps it to a local branch: a remote one is never created by accident, and
        // the trailing `--` makes the name a branch even if a file has the same name.
        git_output(&["checkout", "--no-guess", name, "--"], Some(worktree)).map(|_| ())
    }

    fn head_rev(&self, worktree: &Path) -> Result<String> {
        Ok(git_output(&["rev-parse", "HEAD"], Some(worktree))?
            .trim()
            .to_string())
    }

    fn snapshot(&self, worktree: &Path, keep: &str) -> Result<String> {
        let git_dir = git_output(&["rev-parse", "--absolute-git-dir"], Some(worktree))?;
        let index =
            PathBuf::from(git_dir.trim()).join(format!("ataraxia-index-{}", uuid::Uuid::new_v4()));
        let result = snapshot_with_index(worktree, &index, keep);
        let _ = std::fs::remove_file(&index);
        result
    }

    fn tree_id(&self, worktree: &Path, rev: &str) -> Result<String> {
        Ok(
            git_output(&["rev-parse", &format!("{rev}^{{tree}}")], Some(worktree))?
                .trim()
                .to_string(),
        )
    }

    fn changed_files(&self, worktree: &Path, base: &str, head: &str) -> Result<Vec<ChangedFile>> {
        let status = git_output(
            &["diff", "--name-status", "-M", "-z", base, head],
            Some(worktree),
        )?;
        let numstat = git_output(
            &["diff", "--numstat", "-M", "-z", base, head],
            Some(worktree),
        )?;
        Ok(merge_changes(
            parse_name_status(&status),
            parse_numstat(&numstat),
        ))
    }

    fn file_at(&self, worktree: &Path, rev: &str, path: &str) -> Result<Option<String>> {
        let output = Command::new("git")
            .args(["show", &format!("{rev}:{path}")])
            .current_dir(worktree)
            .output()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        if !output.status.success() || output.stdout.contains(&0) {
            return Ok(None);
        }
        Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
    }

    fn diff_file(&self, worktree: &Path, base: &str, head: &str, path: &str) -> Result<String> {
        git_output(&["diff", "-U3", base, head, "--", path], Some(worktree))
    }

    fn resolve_rev(&self, worktree: &Path, spec: &str) -> Result<String> {
        validate_spec(spec)?;
        git_output(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{spec}^{{commit}}"),
            ],
            Some(worktree),
        )
        .map(|out| out.trim().to_string())
        .map_err(|_| {
            Error::new(
                ErrorCode::NotFound,
                format!("`{spec}` is not a branch, tag or commit here"),
            )
        })
    }

    fn merge_base(&self, worktree: &Path, a: &str, b: &str) -> Result<String> {
        git_output(&["merge-base", a, b], Some(worktree))
            .map(|out| out.trim().to_string())
            .map_err(|_| Error::new(ErrorCode::NotFound, "these two revisions share no history"))
    }

    fn list_refs(&self, worktree: &Path) -> Result<GitRefs> {
        let current = git_output(
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            Some(worktree),
        )
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|name| !name.is_empty());
        let listing = git_output(
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname)%09%(objectname)%09%(subject)",
                "refs/heads",
                "refs/remotes",
                "refs/tags",
            ],
            Some(worktree),
        )?;
        let refs = listing
            .lines()
            .filter_map(|line| {
                let mut parts = line.splitn(3, '\t');
                let full = parts.next()?;
                let rev = parts.next()?.to_string();
                let subject = parts.next().unwrap_or_default().to_string();
                let (kind, name) = if let Some(name) = full.strip_prefix("refs/heads/") {
                    ("branch", name)
                } else if let Some(name) = full.strip_prefix("refs/remotes/") {
                    if name.ends_with("/HEAD") {
                        return None;
                    }
                    ("remote", name)
                } else {
                    ("tag", full.strip_prefix("refs/tags/")?)
                };
                Some(RefInfo {
                    name: name.to_string(),
                    kind: kind.into(),
                    rev,
                    subject,
                })
            })
            .collect();
        let log = git_output(
            &["log", "-n", "40", &format!("--format={COMMIT_FORMAT}")],
            Some(worktree),
        )
        .unwrap_or_default();
        let commits = log.lines().filter_map(parse_commit).collect();
        Ok(GitRefs {
            current,
            refs,
            commits,
        })
    }

    fn commit_info(&self, worktree: &Path, rev: &str) -> Result<CommitInfo> {
        let full = self.resolve_rev(worktree, rev)?;
        let line = git_output(
            &[
                "log",
                "-n",
                "1",
                &format!("--format={COMMIT_FORMAT}"),
                &full,
            ],
            Some(worktree),
        )?;
        line.lines()
            .find_map(parse_commit)
            .ok_or_else(|| Error::new(ErrorCode::NotFound, format!("`{rev}` is not a commit here")))
    }

    fn commits_touching(
        &self,
        worktree: &Path,
        paths: &[String],
        limit: usize,
    ) -> Result<Vec<CommitInfo>> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let count = limit.to_string();
        let format = format!("--format={COMMIT_FORMAT}");
        let mut args = vec!["log", "-n", &count, &format, "--"];
        args.extend(paths.iter().map(String::as_str));
        let log = git_output(&args, Some(worktree)).unwrap_or_default();
        Ok(log.lines().filter_map(parse_commit).collect())
    }

    fn changed_ranges(
        &self,
        worktree: &Path,
        base: &str,
        head: &str,
        paths: &[String],
    ) -> Result<Vec<Hunk>> {
        let mut args = vec!["diff", "-U0", "--no-color", "-M", base, head, "--"];
        args.extend(paths.iter().map(String::as_str));
        Ok(parse_hunks(&git_output(&args, Some(worktree))?))
    }

    fn files_mentioning(&self, worktree: &Path, rev: &str, name: &str) -> Result<Vec<String>> {
        let output = Command::new("git")
            .args(["grep", "-l", "-w", "-F", "-I", "-e", name, rev, "--"])
            .current_dir(worktree)
            .output()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        // Exit code 1 only means "no match".
        let prefix = format!("{rev}:");
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|line| line.strip_prefix(&prefix).unwrap_or(line).to_string())
            .collect())
    }

    fn list_files(&self, worktree: &Path) -> Result<Vec<String>> {
        let out = git_output(
            &["ls-files", "-co", "--exclude-standard", "-z"],
            Some(worktree),
        )?;
        let mut files: Vec<String> = out
            .split('\0')
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect();
        files.sort();
        files.dedup();
        Ok(files)
    }
}

/// A revision typed by the user goes to git as an argument: keep it to plain revision syntax.
fn validate_spec(spec: &str) -> Result<()> {
    let ok = !spec.is_empty()
        && spec.len() <= 200
        && !spec.starts_with('-')
        && spec
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "._/@^~{}-:".contains(ch));
    if ok {
        Ok(())
    } else {
        Err(Error::new(
            ErrorCode::Invalid,
            "that is not a valid branch, tag or commit name",
        ))
    }
}

fn parse_hunks(diff: &str) -> Vec<Hunk> {
    let range = |text: &str| -> (u32, u32) {
        let text = text.trim_start_matches(['-', '+']);
        match text.split_once(',') {
            Some((start, len)) => (start.parse().unwrap_or(0), len.parse().unwrap_or(0)),
            None => (text.parse().unwrap_or(0), 1),
        }
    };
    diff.lines()
        .filter(|line| line.starts_with("@@ "))
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            parts.next()?;
            let (old_start, old_len) = range(parts.next()?);
            let (new_start, new_len) = range(parts.next()?);
            Some(Hunk {
                old_start,
                old_len,
                new_start,
                new_len,
            })
        })
        .collect()
}

const COMMIT_FORMAT: &str = "%H%x09%h%x09%cI%x09%an%x09%s";

fn parse_commit(line: &str) -> Option<CommitInfo> {
    let mut parts = line.splitn(5, '\t');
    Some(CommitInfo {
        rev: parts.next()?.to_string(),
        short: parts.next()?.to_string(),
        date: parts.next()?.to_string(),
        author: parts.next()?.to_string(),
        subject: parts.next().unwrap_or_default().to_string(),
    })
}

fn snapshot_with_index(worktree: &Path, index: &Path, keep: &str) -> Result<String> {
    let envs = [
        ("GIT_INDEX_FILE", index.as_os_str().to_owned()),
        ("GIT_AUTHOR_NAME", "Ataraxia".into()),
        ("GIT_AUTHOR_EMAIL", "ataraxia@localhost".into()),
        ("GIT_COMMITTER_NAME", "Ataraxia".into()),
        ("GIT_COMMITTER_EMAIL", "ataraxia@localhost".into()),
    ];
    let run = |args: &[&str]| -> Result<String> {
        let mut command = Command::new("git");
        command.args(args).current_dir(worktree);
        for (key, value) in &envs {
            command.env(key, value);
        }
        let output = command
            .output()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        if !output.status.success() {
            return Err(Error::new(
                ErrorCode::Io,
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    };
    let head = run(&["rev-parse", "--verify", "-q", "HEAD"]).ok();
    if head.is_some() {
        run(&["read-tree", "HEAD"])?;
    }
    run(&["add", "-A", "--", "."])?;
    let tree = run(&["write-tree"])?;
    let tree = tree.trim();
    let message = "ataraxia snapshot";
    let commit = match head.as_deref().map(str::trim) {
        Some(parent) => run(&["commit-tree", tree, "-p", parent, "-m", message])?,
        None => run(&["commit-tree", tree, "-m", message])?,
    };
    let commit = commit.trim().to_string();
    run(&["update-ref", &format!("refs/ataraxia/{keep}"), &commit])?;
    Ok(commit)
}

/// `(status letter, path, old path)` per entry of `git diff --name-status -z`.
fn parse_name_status(input: &str) -> Vec<(String, String, Option<String>)> {
    let mut parts = input.split('\0').filter(|part| !part.is_empty());
    let mut out = Vec::new();
    while let Some(status) = parts.next() {
        if status.starts_with('R') || status.starts_with('C') {
            let (Some(old), Some(new)) = (parts.next(), parts.next()) else {
                break;
            };
            out.push((status.to_string(), new.to_string(), Some(old.to_string())));
        } else {
            let Some(path) = parts.next() else { break };
            out.push((status.to_string(), path.to_string(), None));
        }
    }
    out
}

/// `(path, additions, deletions, binary)` per entry of `git diff --numstat -z`.
fn parse_numstat(input: &str) -> Vec<(String, u32, u32, bool)> {
    let mut parts = input.split('\0');
    let mut out = Vec::new();
    while let Some(head) = parts.next() {
        if head.is_empty() {
            continue;
        }
        let mut fields = head.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            // Rename: the next two entries are the old and the new path.
            let _old = parts.next();
            parts.next().unwrap_or_default().to_string()
        } else {
            path.to_string()
        };
        let binary = added == "-" || deleted == "-";
        out.push((
            path,
            added.parse().unwrap_or(0),
            deleted.parse().unwrap_or(0),
            binary,
        ));
    }
    out
}

fn merge_changes(
    status: Vec<(String, String, Option<String>)>,
    numstat: Vec<(String, u32, u32, bool)>,
) -> Vec<ChangedFile> {
    let mut files: Vec<ChangedFile> = status
        .into_iter()
        .map(|(letter, path, old_path)| {
            let stats = numstat.iter().find(|item| item.0 == path);
            ChangedFile {
                change: FileChange::from_status(&letter),
                old_path,
                additions: stats.map_or(0, |item| item.1),
                deletions: stats.map_or(0, |item| item.2),
                binary: stats.is_some_and(|item| item.3),
                path,
            }
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

fn git_output(args: &[&str], cwd: Option<&Path>) -> Result<String> {
    let mut command = Command::new("git");
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command
        .output()
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            stderr
        };
        let code = if message.contains("not a git repository") {
            ErrorCode::NotARepo
        } else {
            ErrorCode::Io
        };
        return Err(Error::new(code, message));
    }
    String::from_utf8(output.stdout).map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
}

fn parse_worktree_porcelain(input: &str) -> Result<Vec<WorktreeInfo>> {
    let mut worktrees = Vec::new();
    let mut path: Option<PathBuf> = None;
    let mut head: Option<String> = None;
    let mut branch: Option<String> = None;

    let flush = |worktrees: &mut Vec<WorktreeInfo>,
                 path: &mut Option<PathBuf>,
                 head: &mut Option<String>,
                 branch: &mut Option<String>| {
        if let Some(path) = path.take() {
            worktrees.push(WorktreeInfo {
                path,
                branch: branch.take(),
                head: head.take(),
            });
        } else {
            *head = None;
            *branch = None;
        }
    };

    for raw_line in input.lines() {
        let line = raw_line.trim_end();
        if line.is_empty() {
            flush(&mut worktrees, &mut path, &mut head, &mut branch);
            continue;
        }
        if let Some(value) = line.strip_prefix("worktree ") {
            flush(&mut worktrees, &mut path, &mut head, &mut branch);
            path = Some(PathBuf::from(value));
        } else if let Some(value) = line.strip_prefix("HEAD ") {
            head = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("branch ") {
            branch = Some(
                value
                    .strip_prefix("refs/heads/")
                    .unwrap_or(value)
                    .to_string(),
            );
        } else if line == "detached" {
            branch = None;
        }
    }
    flush(&mut worktrees, &mut path, &mut head, &mut branch);

    if worktrees.is_empty() {
        return Err(Error::new(
            ErrorCode::NotARepo,
            "git worktree list returned no worktrees",
        ));
    }
    Ok(worktrees)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ataraxia-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let git = |args: &[&str]| {
            git_output(args, Some(&dir)).expect("git");
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").expect("write");
        std::fs::write(dir.join("old.txt"), "keep me\nkeep me too\nand me\n").expect("write");
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn snapshots_capture_the_working_tree_without_touching_it() {
        let repo = temp_repo();
        let git = GitCli;
        let base = git.snapshot(&repo, "t/base").expect("base");
        std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").expect("write");
        std::fs::write(repo.join("new.txt"), "fresh\n").expect("write");
        std::fs::rename(repo.join("old.txt"), repo.join("renamed.txt")).expect("rename");
        let head = git.snapshot(&repo, "t/head").expect("head");

        // Nothing was staged or committed.
        let status = git_output(&["status", "--porcelain"], Some(&repo)).expect("status");
        assert!(status.contains("?? new.txt"), "{status}");
        assert_eq!(
            git.head_rev(&repo).expect("head"),
            git_output(&["rev-parse", "HEAD"], Some(&repo))
                .unwrap()
                .trim()
        );

        let files = git.changed_files(&repo, &base, &head).expect("diff");
        let by_path = |path: &str| files.iter().find(|file| file.path == path).cloned();
        let a = by_path("a.txt").expect("a.txt");
        assert_eq!(
            (a.change, a.additions, a.deletions),
            (FileChange::Modified, 1, 0)
        );
        assert_eq!(by_path("new.txt").expect("new").change, FileChange::Added);
        let renamed = by_path("renamed.txt").expect("renamed");
        assert_eq!(renamed.change, FileChange::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));

        assert_eq!(
            git.file_at(&repo, &base, "a.txt").unwrap().as_deref(),
            Some("one\ntwo\n")
        );
        assert_eq!(
            git.file_at(&repo, &head, "a.txt").unwrap().as_deref(),
            Some("one\ntwo\nthree\n")
        );
        assert_eq!(git.file_at(&repo, &base, "new.txt").unwrap(), None);
        assert_ne!(
            git.tree_id(&repo, &base).unwrap(),
            git.tree_id(&repo, &head).unwrap()
        );
        // Snapshotting an unchanged tree yields the same tree id.
        let again = git.snapshot(&repo, "t/head-again").unwrap();
        assert_eq!(
            git.tree_id(&repo, &head).unwrap(),
            git.tree_id(&repo, &again).unwrap()
        );
        let listed = git.list_files(&repo).expect("list");
        assert!(listed.contains(&"new.txt".to_string()));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn compares_arbitrary_revisions_and_lists_what_can_be_compared() {
        let repo = temp_repo();
        let git = GitCli;
        let first = git.head_rev(&repo).unwrap();
        git_output(&["checkout", "-q", "-b", "feature"], Some(&repo)).unwrap();
        std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        git_output(&["commit", "-qam", "add three"], Some(&repo)).unwrap();
        git_output(&["tag", "v1"], Some(&repo)).unwrap();
        git_output(&["checkout", "-q", "main"], Some(&repo)).unwrap();
        std::fs::write(repo.join("other.txt"), "x\n").unwrap();
        git_output(&["add", "."], Some(&repo)).unwrap();
        git_output(&["commit", "-qm", "main moves on"], Some(&repo)).unwrap();

        assert_eq!(
            git.resolve_rev(&repo, "feature").unwrap(),
            git.resolve_rev(&repo, "v1").unwrap()
        );
        assert_eq!(git.resolve_rev(&repo, &first[..8]).unwrap(), first);
        assert!(git.resolve_rev(&repo, "nope").is_err());
        for evil in ["--output=/tmp/x", "a b", "x;rm", "", "$(id)"] {
            assert_eq!(
                git.resolve_rev(&repo, evil).unwrap_err().code,
                ErrorCode::Invalid,
                "{evil:?}"
            );
        }

        // The merge base is where feature left main, so main's own commit is not "in" the diff.
        let base = git.merge_base(&repo, "main", "feature").unwrap();
        assert_eq!(base, first);
        let files = git
            .changed_files(&repo, &base, &git.resolve_rev(&repo, "feature").unwrap())
            .unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.txt");
        let ranges = git
            .changed_ranges(
                &repo,
                &base,
                &git.resolve_rev(&repo, "feature").unwrap(),
                &["a.txt".to_string()],
            )
            .unwrap();
        assert_eq!(
            ranges,
            vec![Hunk {
                old_start: 2,
                old_len: 0,
                new_start: 3,
                new_len: 1
            }]
        );

        let refs = git.list_refs(&repo).unwrap();
        assert_eq!(refs.current.as_deref(), Some("main"));
        assert!(
            refs.refs
                .iter()
                .any(|item| item.name == "feature" && item.kind == "branch")
        );
        assert!(
            refs.refs
                .iter()
                .any(|item| item.name == "v1" && item.kind == "tag")
        );
        assert_eq!(refs.commits[0].subject, "main moves on");

        let mentions = git.files_mentioning(&repo, "HEAD", "two").unwrap();
        assert_eq!(mentions, vec!["a.txt".to_string()]);
        assert!(
            git.files_mentioning(&repo, "HEAD", "zzzzzz")
                .unwrap()
                .is_empty()
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn parses_zero_context_hunk_headers() {
        let hunks = parse_hunks("@@ -3 +3 @@ x\n-a\n+b\n@@ -10,2 +10,0 @@\n@@ -0,0 +1,5 @@\n");
        assert_eq!(
            hunks[0],
            Hunk {
                old_start: 3,
                old_len: 1,
                new_start: 3,
                new_len: 1
            }
        );
        assert_eq!(
            hunks[1],
            Hunk {
                old_start: 10,
                old_len: 2,
                new_start: 10,
                new_len: 0
            }
        );
        assert_eq!(
            hunks[2],
            Hunk {
                old_start: 0,
                old_len: 0,
                new_start: 1,
                new_len: 5
            }
        );
    }

    #[test]
    fn parses_porcelain_worktrees() {
        let input = "\
worktree /tmp/repo
HEAD abcdef
branch refs/heads/main

worktree /tmp/repo-feature
HEAD 123456
branch refs/heads/feature

worktree /tmp/repo-detached
HEAD deadbeef
detached
";
        let parsed = parse_worktree_porcelain(input).expect("parse");
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].path, PathBuf::from("/tmp/repo"));
        assert_eq!(parsed[0].branch.as_deref(), Some("main"));
        assert_eq!(parsed[1].branch.as_deref(), Some("feature"));
        assert_eq!(parsed[2].branch, None);
        assert_eq!(parsed[2].head.as_deref(), Some("deadbeef"));
    }
}
