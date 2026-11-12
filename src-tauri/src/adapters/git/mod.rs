//! Git CLI adapter.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::domain::{Error, ErrorCode, RepoInfo, Result, WorktreeInfo};
use crate::ports::Git;

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
