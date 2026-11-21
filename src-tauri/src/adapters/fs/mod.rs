//! Filesystem adapter. Everything that takes a relative path is confined to the worktree root.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::domain::{Error, ErrorCode, Result};
use crate::ports::{FileContent, Fs, ProjectFileAction};

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

fn git_metadata(name: &std::ffi::OsStr) -> bool {
    name.eq_ignore_ascii_case(".git")
}

fn project_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let mut path = root.to_path_buf();
    let mut parts = relative.split('/').peekable();
    while let Some(part) = parts.next() {
        let mut components = Path::new(part).components();
        if !matches!(components.next(), Some(Component::Normal(name)) if name == part)
            || components.next().is_some()
            || part.contains('\0')
            || cfg!(windows) && (part.contains([':', '\\']) || part.ends_with(['.', ' ']))
            || git_metadata(part.as_ref())
        {
            return Err(Error::new(ErrorCode::Invalid, "invalid project path"));
        }
        path.push(part);
        if parts.peek().is_some() && !std::fs::symlink_metadata(&path).map_err(io)?.is_dir() {
            return Err(Error::new(
                ErrorCode::Invalid,
                "parent must be a folder, without symbolic links",
            ));
        }
    }
    let parent = path.parent().expect("project path has a parent");
    let canonical = parent.canonicalize().map_err(io)?;
    let inside = canonical.strip_prefix(root).is_ok_and(|parent| {
        parent
            .components()
            .all(|part| !git_metadata(part.as_os_str()))
    });
    if !inside {
        return Err(Error::new(
            ErrorCode::Invalid,
            "path leaves the project folders",
        ));
    }
    // Resolve the parent only. Moving or trashing a link acts on the link itself.
    let target = canonical.join(path.file_name().expect("project path has a name"));
    #[cfg(windows)]
    if std::fs::symlink_metadata(&target).is_ok_and(|metadata| !metadata.is_symlink())
        && target
            .canonicalize()
            .is_ok_and(|path| path.file_name().is_some_and(git_metadata))
    {
        return Err(Error::new(ErrorCode::Invalid, "invalid project path"));
    }
    Ok(target)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn move_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    use rustix::fs::{CWD, RenameFlags, renameat_with};
    renameat_with(CWD, from, CWD, to, RenameFlags::NOREPLACE).map_err(Into::into)
}

#[cfg(windows)]
fn move_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let from: Vec<_> = from.as_os_str().encode_wide().chain([0]).collect();
    let to: Vec<_> = to.as_os_str().encode_wide().chain([0]).collect();
    // Both buffers are NUL-terminated and live until the call returns.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn project_change_error(error: std::io::Error) -> Error {
    match error.kind() {
        std::io::ErrorKind::AlreadyExists => {
            Error::new(ErrorCode::Conflict, "An item already exists at that path.")
        }
        std::io::ErrorKind::NotFound => Error::new(
            ErrorCode::NotFound,
            "The item or its parent folder no longer exists.",
        ),
        _ => io(error),
    }
}

fn move_to_trash(path: &Path) -> std::result::Result<(), trash::Error> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};

        let mut context = trash::TrashContext::new();
        context.set_delete_method(DeleteMethod::NsFileManager);
        context.delete(path)
    }
    #[cfg(not(target_os = "macos"))]
    trash::delete(path)
}

fn has_exact_spelling(root: &Path, indexed: &str, on_disk: &str) -> bool {
    let mut parent = root.to_path_buf();
    for (expected, actual) in indexed.split('/').zip(on_disk.split('/')) {
        if expected != actual {
            return std::fs::read_dir(parent)
                .is_ok_and(|entries| entries.flatten().any(|entry| entry.file_name() == expected));
        }
        parent.push(expected);
    }
    true
}

impl Fs for StdFs {
    fn exists(&self, path: &Path) -> Result<bool> {
        Ok(path.exists())
    }

    fn project_paths(&self, root: &Path, mut files: Vec<String>) -> Result<Vec<String>> {
        let root = root.canonicalize().map_err(io)?;
        // The Git index can still name deleted files and represents submodules as single entries.
        files.retain(|path| {
            std::fs::symlink_metadata(root.join(path)).is_ok_and(|metadata| !metadata.is_dir())
        });
        let entries = ignore::WalkBuilder::new(&root)
            .current_dir(&root)
            .hidden(false)
            .ignore(false)
            .filter_entry(|entry| {
                entry.depth() == 0
                    || (!git_metadata(entry.file_name())
                        && (cfg!(any(target_os = "macos", windows))
                            || entry.file_type().is_some_and(|kind| kind.is_dir())))
            })
            .build();
        let mut actual_case: HashMap<String, Option<String>> = HashMap::new();
        let mut folders = Vec::new();
        for entry in entries.flatten().filter(|entry| entry.depth() > 0) {
            let Ok(relative) = entry.path().strip_prefix(&root) else {
                continue;
            };
            let Some(path) = relative.to_str() else {
                continue;
            };
            #[cfg(windows)]
            let path = path.replace('\\', "/");
            if entry.file_type().is_some_and(|kind| kind.is_dir()) {
                folders.push(format!("{path}/"));
            } else {
                actual_case
                    .entry(path.to_lowercase())
                    .and_modify(|entry| *entry = None)
                    .or_insert_with(|| Some(path.to_string()));
            }
        }
        // On a case-insensitive volume, the index can still hold the old spelling after a rename.
        if !actual_case.is_empty() {
            for path in &mut files {
                if let Some(Some(actual)) = actual_case.get(&path.to_lowercase()) {
                    if actual != path && !has_exact_spelling(&root, path, actual) {
                        path.clone_from(actual);
                    }
                }
            }
        }
        files.extend(folders);
        files.sort_unstable();
        files.dedup();
        Ok(files)
    }

    fn change_project_file(&self, root: &Path, action: ProjectFileAction) -> Result<()> {
        let root = root.canonicalize().map_err(io)?;
        match action {
            ProjectFileAction::CreateFile { path } => {
                std::fs::File::create_new(project_path(&root, &path)?)
                    .map(|_| ())
                    .map_err(project_change_error)
            }
            ProjectFileAction::CreateFolder { path } => {
                std::fs::create_dir(project_path(&root, &path)?).map_err(project_change_error)
            }
            ProjectFileAction::Move { path, to } => {
                let from = project_path(&root, &path)?;
                let to = project_path(&root, &to)?;
                move_exclusive(&from, &to).map_err(project_change_error)
            }
            ProjectFileAction::Trash { path } => {
                let path = project_path(&root, &path)?;
                std::fs::symlink_metadata(&path).map_err(project_change_error)?;
                move_to_trash(&path).map_err(|error| {
                    Error::new(ErrorCode::Io, format!("Could not move to Trash. {error}"))
                })
            }
        }
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
    #[cfg(unix)]
    fn file_actions_move_a_link_without_following_it() {
        use ProjectFileAction::{CreateFile, Move};

        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let target = other.path().join("original");
        std::fs::write(&target, "contents").unwrap();
        std::os::unix::fs::symlink(other.path(), root.path().join("outside")).unwrap();
        assert!(
            StdFs
                .change_project_file(
                    root.path(),
                    CreateFile {
                        path: "outside/new".into()
                    }
                )
                .is_err()
        );
        StdFs
            .change_project_file(
                root.path(),
                Move {
                    path: "outside".into(),
                    to: "moved".into(),
                },
            )
            .unwrap();
        assert_eq!(
            std::fs::read_link(root.path().join("moved")).unwrap(),
            other.path()
        );
        assert_eq!(std::fs::read_to_string(target).unwrap(), "contents");
        assert!(!other.path().join("new").exists());
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
