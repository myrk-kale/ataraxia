//! Cheap looks at a worktree, to notice that something changed under the app.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use super::git_output;
use crate::domain::{Error, ErrorCode, Result};
use crate::ports::FilesProbe;

/// The directory that holds a worktree's own `HEAD` and index: `.git`, or, in a linked worktree,
/// the directory its `.git` file points at.
fn git_dir_of(worktree: &Path) -> Result<PathBuf> {
    let dot_git = worktree.join(".git");
    if !dot_git.is_file() {
        return Ok(dot_git);
    }
    let text = std::fs::read_to_string(&dot_git)
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    let target = text
        .trim()
        .strip_prefix("gitdir:")
        .map(str::trim)
        .ok_or_else(|| Error::new(ErrorCode::NotARepo, "unreadable .git file"))?;
    let target = PathBuf::from(target);
    Ok(if target.is_absolute() {
        target
    } else {
        worktree.join(target)
    })
}

fn read_head(git_dir: &Path) -> Result<String> {
    std::fs::read_to_string(git_dir.join("HEAD"))
        .map(|text| text.trim().to_string())
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
}

/// What `HEAD` says right now (`ref: refs/heads/main`, or a commit id when detached).
pub fn head_marker(worktree: &Path) -> Result<String> {
    read_head(&git_dir_of(worktree)?)
}

/// Where the refs live: the main `.git`, which a linked worktree names in its `commondir` file.
fn common_dir_of(git_dir: &Path) -> PathBuf {
    match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(text) => git_dir.join(text.trim()),
        Err(_) => git_dir.to_path_buf(),
    }
}

/// The commit a ref points at, from its loose file or from `packed-refs`.
fn resolve_ref(common_dir: &Path, name: &str) -> Option<String> {
    if let Ok(text) = std::fs::read_to_string(common_dir.join(name)) {
        return Some(text.trim().to_string());
    }
    let packed = std::fs::read_to_string(common_dir.join("packed-refs")).ok()?;
    packed.lines().find_map(|line| {
        let (id, packed_name) = line.split_once(' ')?;
        (packed_name == name).then(|| id.to_string())
    })
}

/// Size and modification time of a file, or `gone` when it does not exist.
fn stat_stamp(path: &Path) -> String {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            let nanos = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |span| span.as_nanos());
            format!("{}:{nanos}", meta.len())
        }
        Err(_) => "gone".into(),
    }
}

/// `HEAD`, the commit it resolves to, and the index's size and time: file reads only.
pub fn files_probe(worktree: &Path) -> Result<FilesProbe> {
    let git_dir = git_dir_of(worktree)?;
    let marker = read_head(&git_dir)?;
    let commit = marker
        .strip_prefix("ref:")
        .map(str::trim)
        .and_then(|name| resolve_ref(&common_dir_of(&git_dir), name))
        .unwrap_or_default();
    Ok(FilesProbe {
        head: format!("{marker} {commit}"),
        index: stat_stamp(&git_dir.join("index")),
    })
}

/// A hash of `git status` and of the size and time of each file it lists, so an edit to a file
/// that was already modified still shows.
pub fn status_stamp(worktree: &Path) -> Result<String> {
    // No optional locks: this must never rewrite the index behind the person's back.
    let status = git_output(
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
        Some(worktree),
    )?;
    let mut hasher = DefaultHasher::new();
    status.hash(&mut hasher);
    let mut entries = status.split('\0').filter(|part| part.len() > 3);
    while let Some(entry) = entries.next() {
        let (Some(code), Some(path)) = (entry.get(..3), entry.get(3..)) else {
            continue;
        };
        // A rename or a copy lists the old path next: it is gone, nothing to look at.
        if code.contains(['R', 'C']) {
            entries.next();
        }
        stat_stamp(&worktree.join(path)).hash(&mut hasher);
    }
    Ok(format!("{:016x}", hasher.finish()))
}
