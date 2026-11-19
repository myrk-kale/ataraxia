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

/// What the user switched off, and where a workspace keeps its own skills and MCP servers. Skills
/// are named by id and MCP servers by name; anything not listed stays on.
#[derive(Debug, Clone, Default)]
pub struct ResourcePolicy {
    pub workspace_dir: Option<PathBuf>,
    pub disabled_skills: std::collections::HashSet<String>,
    pub disabled_mcps: std::collections::HashSet<String>,
}

/// The folder of the user's Ataraxia configuration (`~/.config/ataraxia` or under `XDG_CONFIG_HOME`).
pub(super) fn user_config_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| home.map(|path| path.join(".config")))
        .map(|path| path.join("ataraxia"))
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

/// The name of the MCP server Ataraxia adds to every chat: its tools reach the app itself.
pub const ATARAXIA_MCP: &str = "ataraxia";

impl AgentConfiguration {
    /// Adds the `ataraxia` MCP server (the memory tools), reached over the local API with the
    /// chat's own token, and writes it into the chat's MCP file. It replaces a server a user
    /// configured under the same name.
    pub fn attach_ataraxia_server(&mut self, access: &crate::ports::ApiAccess) -> Result<()> {
        self.mcp_servers.insert(
            ATARAXIA_MCP.into(),
            json!({
                "url": format!("{}/mcp", access.url),
                "headers": { "Authorization": format!("Bearer {}", access.token) }
            }),
        );
        if let Some(path) = &self.mcp_config_path {
            write_mcp_config(path, &self.mcp_servers)?;
        }
        Ok(())
    }

    pub fn load(
        cwd: &Path,
        session_id: SessionId,
        data_dir: Option<&Path>,
        repository_mcp_fingerprint: Option<&str>,
    ) -> Result<Self> {
        Self::load_with(
            cwd,
            session_id,
            data_dir,
            repository_mcp_fingerprint,
            &ResourcePolicy::default(),
        )
    }

    /// [`Self::load`] with a policy: the workspace's own skills and MCP servers join the user's
    /// and the repository's, and what the user switched off is left out.
    pub fn load_with(
        cwd: &Path,
        session_id: SessionId,
        data_dir: Option<&Path>,
        repository_mcp_fingerprint: Option<&str>,
        policy: &ResourcePolicy,
    ) -> Result<Self> {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let user_config = user_config_dir();
        let repository = repository_root(cwd);

        let mut servers = Map::new();
        if let Some(root) = &user_config {
            merge_mcp_file(&root.join("mcp.json"), &mut servers)?;
        }
        if let Some(root) = &policy.workspace_dir {
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

        servers.retain(|name, _| !policy.disabled_mcps.contains(name));

        let skill_roots: Vec<PathBuf> = [
            home.as_ref().map(|root| root.join(".agents/skills")),
            policy
                .workspace_dir
                .as_ref()
                .map(|root| root.join("skills")),
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
        let skills: Vec<SkillDefinition> = skills_by_id
            .into_values()
            .filter(|skill| !policy.disabled_skills.contains(&skill.id))
            .take(MAX_SKILLS)
            .collect();

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
        if let (Some(root), Some(path)) = (data_dir, &mcp_config_path) {
            for server in servers.values_mut() {
                super::mcp_oauth::apply(root, server);
            }
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

/// Writes the session's Codex config while carrying over the selected account's credentials.
pub fn prepare_isolated_home(
    root: &Path,
    auth_source: Option<&Path>,
    mcp_servers: &Map<String, Value>,
) -> Result<PathBuf> {
    prepare_private_dir(root)?;
    let codex_config = root.join("config.toml");
    let config = toml::to_string(&json!({
        "project_doc_max_bytes": 0,
        "features": { "apps": false, "plugins": false, "remote_plugin": false },
        "mcp_servers": mcp_servers
    }))
    .map_err(|_| Error::new(ErrorCode::Invalid, "could not encode Codex configuration"))?;
    let write_config = || -> std::io::Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(root)?;
        file.write_all(config.as_bytes())?;
        file.persist(&codex_config)?;
        Ok(())
    };
    write_config().map_err(|error| {
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
        link_credentials(source, &destination)?;
    }
    // Codex refreshes file-backed MCP credentials in place and refuses to write through symlinks.
    let oauth_target = root.join(".credentials.json");
    let oauth_store = auth_source
        .and_then(Path::parent)
        .map(|home| home.join(".credentials.json"));
    let sync_oauth = || -> std::io::Result<()> {
        if let Some(source) = oauth_store.filter(|store| store.is_file()) {
            let mut file = tempfile::NamedTempFile::new_in(root)?;
            std::io::copy(&mut fs::File::open(source)?, &mut file)?;
            file.persist(&oauth_target)?;
        } else {
            match fs::remove_file(&oauth_target) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    };
    sync_oauth().map_err(|error| {
        Error::new(
            ErrorCode::Io,
            format!("could not prepare Codex MCP credentials: {error}"),
        )
    })?;
    Ok(root.to_path_buf())
}

fn link_credentials(source: &Path, destination: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, destination).map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("could not link Codex credentials: {error}"),
            )
        })
    }
    #[cfg(not(unix))]
    {
        fs::copy(source, destination).map(|_| ()).map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("could not copy Codex credentials: {error}"),
            )
        })
    }
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

pub(super) fn repository_root(cwd: &Path) -> Option<PathBuf> {
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

pub(super) fn read_mcp_entries(path: &Path) -> Result<Option<(Map<String, Value>, String)>> {
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

pub(super) fn validate_mcp_server(path: &Path, name: &str, config: &Value) -> Result<()> {
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

pub(super) fn collect_skills(root: &Path, skills: &mut BTreeMap<String, SkillDefinition>) {
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

pub(super) fn parse_skill(path: &Path, skill_dir: &Path) -> Option<SkillDefinition> {
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

/// The portable entries in the shape Claude Code reads. A remote server needs its transport
/// spelled out: Claude takes an entry without `type` for a local command and, finding no
/// command, drops the server without a word, so the agent never sees its tools.
pub(super) fn claude_mcp_servers(servers: &Map<String, Value>) -> Map<String, Value> {
    servers
        .iter()
        .map(|(name, server)| {
            let mut server = server.clone();
            if let Some(config) = server.as_object_mut() {
                let transport = config.remove("transport");
                if config.contains_key("url") && !config.contains_key("type") {
                    let kind = transport
                        .as_ref()
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| remote_transport(config.get("url")).to_string());
                    config.insert("type".into(), Value::String(kind));
                }
            }
            (name.clone(), server)
        })
        .collect()
}

/// `sse` for an endpoint that says so in its path, streamable HTTP otherwise (what remote MCP
/// servers speak today).
pub(super) fn remote_transport(url: Option<&Value>) -> &'static str {
    let path = url
        .and_then(Value::as_str)
        .map(|url| {
            url.split(['?', '#'])
                .next()
                .unwrap_or(url)
                .trim_end_matches('/')
        })
        .unwrap_or_default();
    if path.ends_with("/sse") {
        "sse"
    } else {
        "http"
    }
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
    let bytes = serde_json::to_vec_pretty(&json!({ "mcpServers": claude_mcp_servers(servers) }))
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

        let servers = Map::new();
        let oauth = profiles.join(".credentials.json");
        fs::write(&oauth, "{}").expect("write profile MCP credentials");
        prepare_isolated_home(&root.join("home"), Some(&profile_a), &servers)
            .expect("select profile A");
        let config =
            fs::read_to_string(root.join("home/config.toml")).expect("read private config");
        let config: toml::Table = toml::from_str(&config).expect("parse private config");
        assert_eq!(config["project_doc_max_bytes"].as_integer(), Some(0));
        assert_eq!(config["features"]["plugins"].as_bool(), Some(false));
        let oauth_target = root.join("home/.credentials.json");
        assert!(fs::symlink_metadata(&oauth_target).unwrap().is_file());
        assert_eq!(fs::read_to_string(&oauth_target).unwrap(), "{}");
        assert_eq!(
            fs::read_to_string(root.join("home/auth.json")).expect("read profile A"),
            "account-a"
        );
        fs::remove_file(oauth).expect("clear profile MCP credentials");
        prepare_isolated_home(&root.join("home"), Some(&profile_b), &servers)
            .expect("switch to profile B");
        assert!(!oauth_target.exists());
        assert_eq!(
            fs::read_to_string(root.join("home/auth.json")).expect("read profile B"),
            "account-b"
        );
        prepare_isolated_home(&root.join("home"), None, &servers).expect("clear profile auth");
        assert!(fs::symlink_metadata(root.join("home/auth.json")).is_err());

        fs::remove_dir_all(root).expect("clean temporary directory");
    }

    #[test]
    fn every_chat_gets_the_ataraxia_server_with_its_own_token_in_the_file_claude_reads() {
        let root = temporary_directory("ataraxia-mcp");
        let session_id = SessionId::new();
        let cwd = root.join("repo");
        fs::create_dir_all(&cwd).expect("repository directory");
        let mut config =
            AgentConfiguration::load(&cwd, session_id, Some(&root), None).expect("configuration");
        assert!(!config.mcp_servers.contains_key(ATARAXIA_MCP));
        let access = crate::ports::ApiAccess {
            url: "http://127.0.0.1:4010".into(),
            token: "tok-123".into(),
        };
        config.attach_ataraxia_server(&access).expect("attach");

        let server = &config.mcp_servers[ATARAXIA_MCP];
        assert_eq!(server["url"], "http://127.0.0.1:4010/mcp");
        assert_eq!(server["headers"]["Authorization"], "Bearer tok-123");
        // Claude reads the same server from the chat's file, with its transport spelled out.
        let path = config.mcp_config_path.clone().expect("a config file");
        let written: Value =
            serde_json::from_str(&fs::read_to_string(path).expect("read")).expect("json");
        assert_eq!(written["mcpServers"][ATARAXIA_MCP]["type"], "http");
        assert_eq!(
            written["mcpServers"][ATARAXIA_MCP]["headers"]["Authorization"],
            "Bearer tok-123"
        );
        // Codex takes the headers under another name, and OpenCode reads it as a remote server.
        let codex = super::super::codex::codex_mcp_servers_for_test(&config.mcp_servers);
        assert_eq!(
            codex[ATARAXIA_MCP]["http_headers"]["Authorization"],
            "Bearer tok-123"
        );
        let _ = fs::remove_dir_all(root);
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

    #[test]
    fn a_remote_server_reaches_claude_with_its_transport_spelled_out() {
        let servers = json!({
            "Notion": { "url": "https://mcp.notion.com/mcp" },
            "legacy": { "url": "https://example.test/sse/" },
            "chosen": { "url": "https://example.test/mcp", "transport": "sse" },
            "typed": { "type": "http", "url": "https://example.test/x" },
            "local": { "command": "mcp-tool", "args": ["--stdio"] }
        });
        let converted = claude_mcp_servers(servers.as_object().unwrap());
        assert_eq!(converted["Notion"]["type"], "http");
        assert_eq!(converted["legacy"]["type"], "sse");
        assert_eq!(converted["chosen"]["type"], "sse");
        assert!(converted["chosen"].get("transport").is_none());
        assert_eq!(converted["typed"]["type"], "http");
        assert!(converted["local"].get("type").is_none());
    }
}
