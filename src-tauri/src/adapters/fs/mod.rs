//! Filesystem adapter. Everything that takes a relative path is confined to the worktree root.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::domain::{Error, ErrorCode, Result};
use crate::ports::{FileContent, Fs};

const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Default, Clone, Copy)]
pub struct StdFs;

fn io(error: std::io::Error) -> Error {
    Error::new(ErrorCode::Io, error.to_string())
}

fn mtime_ms(path: &Path) -> Result<i64> {
    let modified = std::fs::metadata(path)
        .map_err(io)?
        .modified()
        .map_err(io)?;
    Ok(modified
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0))
}

/// Resolves `relative` under `root`, refusing absolute paths, `..`, `.git` and symlinks that
/// lead outside the root. The target does not have to exist, its parent does.
pub fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf> {
    let relative_path = Path::new(relative);
    if relative.is_empty() || relative_path.is_absolute() {
        return Err(Error::new(ErrorCode::Invalid, "path must be relative"));
    }
    let mut cleaned = PathBuf::new();
    for component in relative_path.components() {
        match component {
            Component::Normal(part) => cleaned.push(part),
            Component::CurDir => {}
            _ => return Err(Error::new(ErrorCode::Invalid, "path leaves the worktree")),
        }
    }
    if cleaned.components().next().map(|part| part.as_os_str()) == Some(".git".as_ref()) {
        return Err(Error::new(
            ErrorCode::Invalid,
            "the .git directory is off limits",
        ));
    }
    let canonical_root = root.canonicalize().map_err(io)?;
    let target = canonical_root.join(&cleaned);
    let anchor = if target.exists() {
        target.canonicalize().map_err(io)?
    } else {
        let parent = target
            .parent()
            .ok_or_else(|| Error::new(ErrorCode::Invalid, "invalid path"))?;
        parent
            .canonicalize()
            .map_err(|_| Error::new(ErrorCode::NotFound, "directory does not exist"))?
            .join(target.file_name().unwrap_or_default())
    };
    if !anchor.starts_with(&canonical_root) {
        return Err(Error::new(ErrorCode::Invalid, "path leaves the worktree"));
    }
    Ok(anchor)
}

impl Fs for StdFs {
    fn exists(&self, path: &Path) -> Result<bool> {
        Ok(path.exists())
    }

    fn read_text(&self, root: &Path, relative: &str) -> Result<FileContent> {
        let path = resolve_inside(root, relative)?;
        let metadata = std::fs::metadata(&path)
            .map_err(|_| Error::new(ErrorCode::NotFound, format!("{relative} does not exist")))?;
        if !metadata.is_file() {
            return Err(Error::new(ErrorCode::Invalid, "not a file"));
        }
        let size = metadata.len();
        let mtime = mtime_ms(&path)?;
        if size > MAX_READ_BYTES {
            return Ok(FileContent {
                path: relative.to_string(),
                text: String::new(),
                binary: false,
                too_large: true,
                size,
                mtime_ms: mtime,
            });
        }
        let bytes = std::fs::read(&path).map_err(io)?;
        let binary = bytes.iter().take(8192).any(|byte| *byte == 0);
        Ok(FileContent {
            path: relative.to_string(),
            text: if binary {
                String::new()
            } else {
                String::from_utf8_lossy(&bytes).into_owned()
            },
            binary,
            too_large: false,
            size,
            mtime_ms: mtime,
        })
    }

    fn write_text(
        &self,
        root: &Path,
        relative: &str,
        text: &str,
        expected_mtime_ms: Option<i64>,
    ) -> Result<i64> {
        let path = resolve_inside(root, relative)?;
        if path.is_dir() {
            return Err(Error::new(ErrorCode::Invalid, "is a directory"));
        }
        if let (true, Some(expected)) = (path.exists(), expected_mtime_ms) {
            if mtime_ms(&path)? != expected {
                return Err(Error::new(
                    ErrorCode::Conflict,
                    format!("{relative} changed on disk since it was opened"),
                ));
            }
        }
        let temp = path.with_extension(format!("ataraxia-{}.tmp", uuid::Uuid::new_v4().simple()));
        std::fs::write(&temp, text).map_err(io)?;
        if let Ok(metadata) = std::fs::metadata(&path) {
            let _ = std::fs::set_permissions(&temp, metadata.permissions());
        }
        std::fs::rename(&temp, &path).map_err(|error| {
            let _ = std::fs::remove_file(&temp);
            io(error)
        })?;
        mtime_ms(&path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ataraxia-fs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    #[test]
    fn reads_writes_and_detects_external_changes() {
        let root = temp_dir();
        std::fs::write(root.join("a.txt"), "hello").expect("seed");
        let fs = StdFs;

        let read = fs.read_text(&root, "a.txt").expect("read");
        assert_eq!(read.text, "hello");
        assert!(!read.binary);

        let mtime = fs
            .write_text(&root, "a.txt", "changed", Some(read.mtime_ms))
            .expect("write");
        assert_eq!(fs.read_text(&root, "a.txt").unwrap().text, "changed");

        // Someone else edits the file: a stale write is refused and nothing is overwritten.
        std::fs::write(root.join("a.txt"), "external").expect("external edit");
        let _ = mtime;
        let stale = fs.write_text(&root, "a.txt", "mine", Some(read.mtime_ms - 5000));
        assert_eq!(stale.unwrap_err().code, ErrorCode::Conflict);
        assert_eq!(fs.read_text(&root, "a.txt").unwrap().text, "external");

        // New files are fine.
        fs.write_text(&root, "b.txt", "new", None).expect("create");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_paths_outside_the_worktree() {
        let root = temp_dir();
        let outside = temp_dir();
        std::fs::write(outside.join("secret.txt"), "nope").expect("seed");
        std::os::unix::fs::symlink(&outside, root.join("link")).expect("symlink");
        let fs = StdFs;

        for bad in [
            "../x",
            "/etc/passwd",
            "a/../../x",
            ".git/config",
            "link/secret.txt",
            "",
        ] {
            assert!(fs.read_text(&root, bad).is_err(), "{bad} must be refused");
            assert!(fs.write_text(&root, bad, "x", None).is_err(), "{bad} write");
        }
        assert!(outside.join("secret.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn flags_binary_files() {
        let root = temp_dir();
        std::fs::write(root.join("blob.bin"), [0u8, 1, 2, 3]).expect("seed");
        let read = StdFs.read_text(&root, "blob.bin").expect("read");
        assert!(read.binary);
        assert!(read.text.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
