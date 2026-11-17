//! Ataraxia-owned agent resources in portable Agent Skills and MCP formats.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::domain::agent::{RepositoryMcpApproval, RepositoryMcpServer};
use crate::domain::ids::SessionId;
use crate::domain::{Error, ErrorCode, Result};

const MAX_INSTRUCTIONS_BYTES: u64 = 64 * 1024;
const MAX_SKILLS: usize = 200;
const MAX_SKILL_DIRECTORIES: usize = 1000;
const MAX_SKILL_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct SkillDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: PathBuf,
}

/// Describes repository MCP servers without exposing their environment or header values.
pub fn repository_mcp_approval(cwd: &Path) -> Result<Option<RepositoryMcpApproval>> {
    let Some(root) = repository_root(cwd) else {
        return Ok(None);
    };
    let Some((entries, contents)) = read_mcp_entries(&root.join(".mcp.json"))? else {
        return Ok(None);
    };
    if entries.is_empty() {
        return Ok(None);
    }
    let repository = root
        .canonicalize()
        .unwrap_or(root)
        .to_string_lossy()
        .into_owned();
    let fingerprint = format!("{:x}", Sha256::digest(contents.as_bytes()));
    let servers = entries
        .into_iter()
        .map(|(name, value)| {
            let config = value.as_object().expect("validated MCP server object");
            let names = |key: &str| {
                config
                    .get(key)
                    .and_then(Value::as_object)
                    .map(|values| values.keys().cloned().collect())
                    .unwrap_or_default()
            };
            RepositoryMcpServer {
                name,
                command: config
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                args: config
                    .get("args")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect(),
                url: config
                    .get("url")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                cwd: config
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                environment: names("env"),
                headers: names("headers"),
            }
        })
        .collect();
    Ok(Some(RepositoryMcpApproval {
        repository,
        fingerprint,
        servers,
    }))
}

#[derive(Debug, Clone, Default)]
pub struct AgentConfiguration {
    /// Standard MCP server objects, keyed by server name.
    pub mcp_servers: Map<String, Value>,
    /// Strict MCP config file consumed by CLI harnesses such as Claude Code.
    pub mcp_config_path: Option<PathBuf>,
    /// Instructions and available skills to introduce to the current conversation.
    pub preamble: String,
    /// Instructions without the portable skill catalog, for native skill integrations.
    pub instructions_preamble: String,
    /// Skills discovered in the Ataraxia user and repository roots.
    pub skills: Vec<SkillDefinition>,
    /// Only the portable user and repository roots are exposed to harnesses.
    pub skill_roots: Vec<PathBuf>,
}

impl AgentConfiguration {
    pub fn load(
        cwd: &Path,
        session_id: SessionId,
        data_dir: Option<&Path>,
        repository_mcp_fingerprint: Option<&str>,
    ) -> Result<Self> {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let user_config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| home.as_ref().map(|path| path.join(".config")))
            .map(|path| path.join("ataraxia"));
        let repository = repository_root(cwd);

        let mut servers = Map::new();
        if let Some(root) = &user_config {
            merge_mcp_file(&root.join("mcp.json"), &mut servers)?;
        }
        if let Some(root) = &repository {
            match read_mcp_entries(&root.join(".mcp.json"))? {
                Some((entries, contents)) => {
                    let fingerprint = format!("{:x}", Sha256::digest(contents.as_bytes()));
                    if repository_mcp_fingerprint == Some(fingerprint.as_str()) {
                        servers.extend(entries);
                    } else if repository_mcp_fingerprint.is_some() {
                        return Err(Error::new(
                            ErrorCode::Conflict,
                            "repository MCP config changed; review the updated servers before trusting it",
                        ));
                    }
                }
                None if repository_mcp_fingerprint.is_some() => {
                    return Err(Error::new(
                        ErrorCode::Conflict,
                        "repository MCP config changed; review the updated servers before trusting it",
                    ));
                }
                None => {}
            }
        }

        let skill_roots: Vec<PathBuf> = [
            home.as_ref().map(|root| root.join(".agents/skills")),
            repository.as_ref().map(|root| root.join(".agents/skills")),
        ]
        .into_iter()
        .flatten()
        .filter(|path| path.is_dir())
        .collect();
        let mut skills_by_id = BTreeMap::new();
        for root in &skill_roots {
            collect_skills(root, &mut skills_by_id);
        }
        let skills: Vec<SkillDefinition> = skills_by_id.into_values().take(MAX_SKILLS).collect();

        let mut instructions = Vec::new();
        if let Some(path) = user_config.as_ref().map(|root| root.join("AGENTS.md")) {
            append_instructions(&path, &mut instructions)?;
        }
        if let Some(path) = repository.as_ref().map(|root| root.join("AGENTS.md")) {
            append_instructions(&path, &mut instructions)?;
        }

        let mut preamble = String::new();
        if !instructions.is_empty() {
            preamble.push_str("Ataraxia instructions (user and repository AGENTS.md):\n\n");
            preamble.push_str(&instructions.join("\n\n"));
            preamble.push_str("\n\n");
        }
        let instructions_preamble = preamble.clone();
        if !skills.is_empty() {
            preamble.push_str("Ataraxia skills available in this session. Read the listed SKILL.md before applying one that fits the task:\n");
            for skill in &skills {
                preamble.push_str(&format!(
                    "- {} ({}): {}; file: {}\n",
                    skill.name,
                    skill.id,
                    skill.description,
                    skill.path.display()
                ));
            }
        }

        let mcp_config_path = data_dir.map(|root| {
            root.join("agent-config")
                .join(format!("{}.mcp.json", session_id.0))
        });
        if let Some(path) = &mcp_config_path {
            write_mcp_config(path, &servers)?;
        }

        Ok(Self {
            mcp_servers: servers,
            mcp_config_path,
            preamble,
            instructions_preamble,
            skills,
            skill_roots,
        })
    }
}

/// Creates a clean Codex home while carrying over only its authentication file.
pub fn prepare_isolated_home(root: &Path, auth_source: Option<&Path>) -> Result<PathBuf> {
    prepare_private_dir(root)?;
    let codex_config = root.join("config.toml");
    match fs::symlink_metadata(&codex_config) {
        Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_dir() => {
            return Err(Error::new(
                ErrorCode::Io,
                format!("{} is not a Codex config file", codex_config.display()),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(Error::new(
                ErrorCode::Io,
                format!("could not inspect {}: {error}", codex_config.display()),
            ));
        }
    }
    fs::write(&codex_config, "project_doc_max_bytes = 0\n\n[features]\napps = false\nplugins = false\nremote_plugin = false\n").map_err(|error| {
        Error::new(
            ErrorCode::Io,
            format!("could not configure {}: {error}", codex_config.display()),
        )
    })?;
    let destination = root.join("auth.json");
    match fs::symlink_metadata(&destination) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            return Err(Error::new(
                ErrorCode::Io,
                format!("{} is not a Codex auth file", destination.display()),
            ));
        }
        Ok(_) => fs::remove_file(&destination).map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("could not replace {}: {error}", destination.display()),
            )
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(Error::new(
                ErrorCode::Io,
                format!("could not inspect {}: {error}", destination.display()),
            ));
        }
    }
    if let Some(source) = auth_source.filter(|source| source.is_file()) {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(source, &destination).map_err(|error| {
                Error::new(
                    ErrorCode::Io,
                    format!("could not link Codex credentials: {error}"),
                )
            })?;
        }
        #[cfg(not(unix))]
        {
            fs::copy(source, &destination).map_err(|error| {
                Error::new(
                    ErrorCode::Io,
                    format!("could not copy Codex credentials: {error}"),
                )
            })?;
        }
    }
    Ok(root.to_path_buf())
}

/// Creates a private directory for a provider's isolated configuration.
pub fn prepare_private_dir(root: &Path) -> Result<()> {
    fs::create_dir_all(root).map_err(|error| {
        Error::new(
            ErrorCode::Io,
            format!("could not create {}: {error}", root.display()),
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("could not secure {}: {error}", root.display()),
            )
        })?;
    }
    Ok(())
}

/// Removes MCP credentials and provider config created for a chat that is being deleted.
pub fn forget_session_config(data_dir: &Path, session_id: &SessionId) -> Result<()> {
    let root = data_dir.join("agent-config");
    let mcp_file = root.join(format!("{}.mcp.json", session_id.0));
    match fs::remove_file(&mcp_file) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(Error::new(
                ErrorCode::Io,
                format!("could not remove {}: {error}", mcp_file.display()),
            ));
        }
    }

    let session_dir = root.join(session_id.0.to_string());
    match fs::remove_dir_all(&session_dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(Error::new(
                ErrorCode::Io,
                format!("could not remove {}: {error}", session_dir.display()),
            ));
        }
    }
    Ok(())
}

fn repository_root(cwd: &Path) -> Option<PathBuf> {
    cwd.ancestors()
        .find(|path| path.join(".git").exists())
        .map(Path::to_path_buf)
}

fn merge_mcp_file(path: &Path, servers: &mut Map<String, Value>) -> Result<()> {
    let Some((entries, _)) = read_mcp_entries(path)? else {
        return Ok(());
    };
    servers.extend(entries);
    Ok(())
}

fn read_mcp_entries(path: &Path) -> Result<Option<(Map<String, Value>, String)>> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(Error::new(
                ErrorCode::Io,
                format!("could not read {}: {error}", path.display()),
            ));
        }
    };
    let value: Value = serde_json::from_str(&contents).map_err(|error| {
        Error::new(
            ErrorCode::Invalid,
            format!("invalid MCP config {}: {error}", path.display()),
        )
    })?;
    let Some(entries) = value.get("mcpServers").and_then(Value::as_object) else {
        return Err(Error::new(
            ErrorCode::Invalid,
            format!("{} must contain an object named mcpServers", path.display()),
        ));
    };
    for (name, config) in entries {
        validate_mcp_server(path, name, config)?;
    }
    Ok(Some((entries.clone(), contents)))
}

fn validate_mcp_server(path: &Path, name: &str, config: &Value) -> Result<()> {
    let invalid = |detail: &str| {
        Error::new(
            ErrorCode::Invalid,
            format!("invalid MCP server {name} in {}: {detail}", path.display()),
        )
    };
    let config = config
        .as_object()
        .ok_or_else(|| invalid("server entry must be an object"))?;
    let command = config.get("command");
    let url = config.get("url");
    if command.is_some() == url.is_some() {
        return Err(invalid("provide exactly one of command or url"));
    }
    if command.is_some_and(|value| !value.as_str().is_some_and(|value| !value.is_empty())) {
        return Err(invalid("command must be a non-empty string"));
    }
    if url.is_some_and(|value| !value.as_str().is_some_and(|value| !value.is_empty())) {
        return Err(invalid("url must be a non-empty string"));
    }
    if config
        .get("cwd")
        .is_some_and(|value| !value.as_str().is_some_and(|value| !value.is_empty()))
    {
        return Err(invalid("cwd must be a non-empty string"));
    }
    if config.get("args").is_some_and(|value| {
        !value
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string))
    }) {
        return Err(invalid("args must be an array of strings"));
    }
    for key in ["env", "headers"] {
        if let Some(values) = config.get(key) {
            let values = values
                .as_object()
                .ok_or_else(|| invalid(&format!("{key} must be an object of strings")))?;
            if values.values().any(|value| !value.is_string()) {
                return Err(invalid(&format!("{key} must be an object of strings")));
            }
        }
    }
    Ok(())
}

fn append_instructions(path: &Path, instructions: &mut Vec<String>) -> Result<()> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(Error::new(
                ErrorCode::Io,
                format!("could not inspect {}: {error}", path.display()),
            ));
        }
    };
    if metadata.len() > MAX_INSTRUCTIONS_BYTES {
        return Err(Error::new(
            ErrorCode::Invalid,
            format!("{} is larger than 64 KiB", path.display()),
        ));
    }
    let text = fs::read_to_string(path).map_err(|error| {
        Error::new(
            ErrorCode::Io,
            format!("could not read {}: {error}", path.display()),
        )
    })?;
    if !text.trim().is_empty() {
        instructions.push(format!("--- {} ---\n{}", path.display(), text.trim()));
    }
    Ok(())
}

fn collect_skills(root: &Path, skills: &mut BTreeMap<String, SkillDefinition>) {
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0;
    while let Some((dir, depth)) = pending.pop() {
        if depth > 6 || visited >= MAX_SKILL_DIRECTORIES {
            continue;
        }
        visited += 1;
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let entries: Vec<_> = entries.filter_map(std::result::Result::ok).collect();
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                pending.push((path.clone(), depth + 1));
                let skill_file = path.join("SKILL.md");
                if let Some(skill) = parse_skill(&skill_file, &path) {
                    if skills.contains_key(&skill.id) || skills.len() < MAX_SKILLS {
                        skills.insert(skill.id.clone(), skill);
                    }
                }
            }
        }
    }
}

fn parse_skill(path: &Path, skill_dir: &Path) -> Option<SkillDefinition> {
    if fs::metadata(path).ok()?.len() > MAX_SKILL_BYTES {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let mut name = None;
    let mut description = None;
    let mut lines = text.lines().peekable();
    if lines.next()?.trim_end_matches('\r') != "---" {
        return None;
    }
    let mut closed = false;
    while let Some(line) = lines.next() {
        let line = line.trim_end_matches('\r');
        if line == "---" {
            closed = true;
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim();
            match key.trim() {
                "name" if !value.is_empty() => name = Some(frontmatter_scalar(value)?),
                "description" if !value.is_empty() => {
                    let marker = value.chars().next();
                    if matches!(marker, Some('>') | Some('|')) {
                        let mut block = Vec::new();
                        while lines.peek().is_some_and(|next| {
                            next.chars().next().is_some_and(char::is_whitespace)
                        }) {
                            if let Some(next) = lines.next() {
                                block.push(next.trim());
                            }
                        }
                        let separator = if marker == Some('|') { "\n" } else { " " };
                        let value = block.join(separator).trim().to_string();
                        description = (!value.is_empty()).then_some(value);
                    } else {
                        description = Some(frontmatter_scalar(value)?)
                    }
                }
                _ => {}
            }
        }
    }
    if !closed {
        return None;
    }
    let id = name?;
    let directory_name = skill_dir.file_name()?.to_string_lossy();
    if id != directory_name
        || id.len() > 64
        || !id.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
        || id.starts_with('-')
        || id.ends_with('-')
        || description
            .as_ref()
            .is_none_or(|value| value.is_empty() || value.chars().count() > 1024)
    {
        return None;
    }
    Some(SkillDefinition {
        name: id.clone(),
        id,
        description: description?,
        path: path.canonicalize().unwrap_or_else(|_| path.to_path_buf()),
    })
}

fn frontmatter_scalar(value: &str) -> Option<String> {
    let value = if value.starts_with('"') || value.starts_with('\'') {
        let quote = value.chars().next()?;
        if !value.ends_with(quote) || value.len() < 2 {
            return None;
        }
        &value[1..value.len() - 1]
    } else {
        value
    };
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn write_mcp_config(path: &Path, servers: &Map<String, Value>) -> Result<()> {
    let parent = path.parent().ok_or_else(|| {
        Error::new(
            ErrorCode::Io,
            "MCP configuration path has no parent directory",
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        Error::new(
            ErrorCode::Io,
            format!("could not create {}: {error}", parent.display()),
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("could not secure {}: {error}", parent.display()),
            )
        })?;
    }
    let bytes = serde_json::to_vec_pretty(&json!({ "mcpServers": servers }))
        .map_err(|error| Error::new(ErrorCode::Invalid, error.to_string()))?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| {
        Error::new(
            ErrorCode::Io,
            format!("could not write {}: {error}", path.display()),
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| {
                Error::new(
                    ErrorCode::Io,
                    format!("could not secure {}: {error}", path.display()),
                )
            })?;
    }
    file.write_all(&bytes).map_err(|error| {
        Error::new(
            ErrorCode::Io,
            format!("could not write {}: {error}", path.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temporary_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ataraxia-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn forgetting_a_session_removes_only_its_provider_configuration() {
        let root = temporary_directory("forget-agent-config");
        let session_id = SessionId::new();
        let config_root = root.join("agent-config");
        let mcp_file = config_root.join(format!("{}.mcp.json", session_id.0));
        let session_file = config_root
            .join(session_id.0.to_string())
            .join("codex-home/auth.json");
        let sibling_file = config_root.join("another-session/settings.json");
        fs::create_dir_all(mcp_file.parent().expect("MCP parent")).expect("MCP directory");
        fs::write(&mcp_file, "MCP credentials").expect("write MCP config");
        fs::create_dir_all(session_file.parent().expect("session parent"))
            .expect("session directory");
        fs::write(&session_file, "provider credentials").expect("write provider config");
        fs::create_dir_all(sibling_file.parent().expect("sibling parent"))
            .expect("sibling directory");
        fs::write(&sibling_file, "keep").expect("write sibling config");

        forget_session_config(&root, &session_id).expect("remove session configuration");

        assert!(!mcp_file.exists());
        assert!(!session_file.parent().unwrap().parent().unwrap().exists());
        assert_eq!(
            fs::read_to_string(&sibling_file).expect("sibling remains"),
            "keep"
        );
        fs::remove_dir_all(root).expect("clean temporary directory");
    }

    #[test]
    fn isolated_codex_home_tracks_profile_auth_and_removes_stale_auth() {
        let root = temporary_directory("codex-profile-auth");
        let profiles = root.join("profiles");
        fs::create_dir_all(&profiles).expect("create profiles");
        let profile_a = profiles.join("a.json");
        let profile_b = profiles.join("b.json");
        fs::write(&profile_a, "account-a").expect("write profile A");
        fs::write(&profile_b, "account-b").expect("write profile B");

        prepare_isolated_home(&root.join("home"), Some(&profile_a)).expect("select profile A");
        assert_eq!(
            fs::read_to_string(root.join("home/config.toml")).expect("read private config"),
            "project_doc_max_bytes = 0\n\n[features]\napps = false\nplugins = false\nremote_plugin = false\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("home/auth.json")).expect("read profile A"),
            "account-a"
        );
        prepare_isolated_home(&root.join("home"), Some(&profile_b)).expect("switch to profile B");
        assert_eq!(
            fs::read_to_string(root.join("home/auth.json")).expect("read profile B"),
            "account-b"
        );
        prepare_isolated_home(&root.join("home"), None).expect("clear profile auth");
        assert!(fs::symlink_metadata(root.join("home/auth.json")).is_err());

        fs::remove_dir_all(root).expect("clean temporary directory");
    }

    #[test]
    fn repository_mcp_approval_shows_commands_but_never_secret_values() {
        let root = temporary_directory("repo-mcp-approval");
        fs::create_dir_all(root.join(".git")).expect("create git marker");
        let config_path = root.join(".mcp.json");
        fs::write(
            &config_path,
            r#"{"mcpServers":{"local":{"command":"/bin/mcp-tool","args":["--serve"],"cwd":"/tmp/attacker","env":{"API_TOKEN":"secret-value"},"headers":{"Authorization":"header-secret"}}}}"#,
        )
        .expect("write MCP config");

        let approval = repository_mcp_approval(&root)
            .expect("parse MCP config")
            .expect("approval required");
        assert_eq!(approval.servers[0].name, "local");
        assert_eq!(
            approval.servers[0].command.as_deref(),
            Some("/bin/mcp-tool")
        );
        assert_eq!(approval.servers[0].args, ["--serve"]);
        assert_eq!(approval.servers[0].cwd.as_deref(), Some("/tmp/attacker"));
        assert_eq!(approval.servers[0].environment, ["API_TOKEN"]);
        assert_eq!(approval.servers[0].headers, ["Authorization"]);
        assert!(!format!("{approval:?}").contains("secret-value"));
        assert!(!format!("{approval:?}").contains("header-secret"));
        let first_fingerprint = approval.fingerprint;

        fs::write(
            &config_path,
            r#"{"mcpServers":{"local":{"command":"/bin/other-tool"}}}"#,
        )
        .expect("change MCP config");
        let changed = repository_mcp_approval(&root)
            .expect("parse changed config")
            .expect("approval required");
        assert_ne!(changed.fingerprint, first_fingerprint);

        fs::remove_dir_all(root).expect("clean temporary directory");
    }
}
