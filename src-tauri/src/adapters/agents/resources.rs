//! Skills and MCP servers as the user manages them: what exists in each scope (global, workspace,
//! project), whether each is switched on there, and the files that define them.
//!
//! A scope marks an item `on`, `off` or leaves it to the broader one (`inherit`); the narrowest
//! scope that says something wins (project over workspace over global), and an item nobody
//! mentioned is on. The marks live in the app's database; definitions live in files: skills as
//! `SKILL.md` folders, MCP servers in `mcp.json` files.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::config::{
    ResourcePolicy, collect_skills, parse_skill, read_mcp_entries, repository_root,
    user_config_dir, validate_mcp_server,
};
use crate::domain::ids::{RepositoryId, WorkspaceId};
use crate::domain::{Error, ErrorCode, Result};
use crate::ports::Store;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Global,
    Workspace,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Skill,
    Mcp,
}

/// Where the user is looking: which scope they edit, in which workspace and repository.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub scope: Scope,
    pub workspace_id: Option<WorkspaceId>,
    pub repository_id: Option<RepositoryId>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct Marks {
    #[serde(default)]
    skills: BTreeMap<String, String>,
    #[serde(default)]
    mcps: BTreeMap<String, String>,
}

impl Marks {
    fn map(&self, kind: Kind) -> &BTreeMap<String, String> {
        match kind {
            Kind::Skill => &self.skills,
            Kind::Mcp => &self.mcps,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceItem {
    /// The skill's id or the MCP server's name.
    pub id: String,
    pub kind: Kind,
    /// What the skill is for, or how the MCP server is started (never its environment values).
    pub description: String,
    /// The narrowest scope that defines it.
    pub defined_in: Scope,
    /// What this scope says: `inherit`, `on` or `off`.
    pub state: String,
    /// Whether it applies for someone at this scope.
    pub effective: bool,
    /// What it would be if this scope said nothing, and the scope that decides that.
    pub inherited: bool,
    pub inherited_from: Option<Scope>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceList {
    pub skills: Vec<ResourceItem>,
    pub mcps: Vec<ResourceItem>,
    /// Definition files that could not be read, with the reason; the rest of the list is intact.
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillText {
    pub description: String,
    pub body: String,
}

pub struct ResourceManager {
    store: Arc<dyn Store>,
    data_dir: PathBuf,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorCode::Invalid, message)
}

fn io(message: String) -> Error {
    Error::new(ErrorCode::Io, message)
}

/// A skill id: lowercase letters, digits and `-`, as the Agent Skills format asks.
pub fn valid_skill_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && !id.ends_with('-')
        && id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn valid_mcp_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
}

/// How an MCP server is started, in one line, without any environment or header value.
fn mcp_summary(config: &Value) -> String {
    if let Some(url) = config.get("url").and_then(Value::as_str) {
        return url.to_string();
    }
    let command = config
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let args = config
        .get("args")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    format!("{command} {args}").trim().to_string()
}

impl ResourceManager {
    pub fn new(store: Arc<dyn Store>, data_dir: PathBuf) -> Self {
        Self { store, data_dir }
    }

    // ------------------------------------------------------------------ marks

    fn marks_key(
        &self,
        scope: Scope,
        workspace: Option<WorkspaceId>,
        repository: Option<RepositoryId>,
    ) -> Result<String> {
        Ok(match scope {
            Scope::Global => "resources/global".into(),
            Scope::Workspace => format!(
                "resources/workspace/{}",
                workspace.ok_or_else(|| invalid("choose a workspace"))?.0
            ),
            Scope::Project => format!(
                "resources/project/{}",
                repository.ok_or_else(|| invalid("choose a repository"))?.0
            ),
        })
    }

    fn marks(&self, key: &str) -> Marks {
        self.store
            .get_preference(key)
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// The scopes that apply, from the broadest to the narrowest.
    fn chain(
        &self,
        workspace: Option<WorkspaceId>,
        repository: Option<RepositoryId>,
        up_to: Scope,
    ) -> Vec<(Scope, String)> {
        let mut chain = vec![(Scope::Global, "resources/global".to_string())];
        if let (Some(id), true) = (workspace, up_to != Scope::Global) {
            chain.push((Scope::Workspace, format!("resources/workspace/{}", id.0)));
        }
        if let (Some(id), Scope::Project) = (repository, up_to) {
            chain.push((Scope::Project, format!("resources/project/{}", id.0)));
        }
        chain
    }

    /// What the agent of a chat must leave out: everything switched off once all scopes spoke.
    pub fn policy_for(
        &self,
        workspace: Option<WorkspaceId>,
        repository: RepositoryId,
    ) -> ResourcePolicy {
        let chain = self.chain(workspace, Some(repository), Scope::Project);
        let layers: Vec<Marks> = chain.iter().map(|(_, key)| self.marks(key)).collect();
        let off = |kind: Kind| -> HashSet<String> {
            let ids: HashSet<&String> = layers
                .iter()
                .flat_map(|layer| layer.map(kind).keys())
                .collect();
            ids.into_iter()
                .filter(|id| {
                    layers
                        .iter()
                        .rev()
                        .find_map(|layer| {
                            layer.map(kind).get(*id).filter(|state| *state != "inherit")
                        })
                        .is_some_and(|state| state == "off")
                })
                .cloned()
                .collect()
        };
        ResourcePolicy {
            workspace_dir: workspace.map(|id| self.workspace_dir(id)),
            disabled_skills: off(Kind::Skill),
            disabled_mcps: off(Kind::Mcp),
        }
    }

    pub fn set_state(&self, context: Context, kind: Kind, id: &str, state: &str) -> Result<()> {
        if !matches!(state, "inherit" | "on" | "off") {
            return Err(invalid("a state is inherit, on or off"));
        }
        if context.scope == Scope::Global && state == "inherit" {
            return Err(invalid("the global scope has nothing to inherit from"));
        }
        let key = self.marks_key(context.scope, context.workspace_id, context.repository_id)?;
        let mut marks = self.marks(&key);
        let map = match kind {
            Kind::Skill => &mut marks.skills,
            Kind::Mcp => &mut marks.mcps,
        };
        if state == "inherit" {
            map.remove(id);
        } else {
            map.insert(id.to_string(), state.to_string());
        }
        let text = serde_json::to_string(&marks).map_err(|error| invalid(error.to_string()))?;
        self.store.set_preference(&key, &text)
    }

    // ------------------------------------------------------------------ where things live

    fn workspace_dir(&self, id: WorkspaceId) -> PathBuf {
        self.data_dir.join("workspaces").join(id.0.to_string())
    }

    fn project_root(&self, repository: RepositoryId) -> Result<PathBuf> {
        let repository = self
            .store
            .get_repository(repository)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "repository not found"))?;
        Ok(repository_root(&repository.root).unwrap_or(repository.root))
    }

    /// The folder holding skills and the `mcp.json` of a scope; `None` when the scope cannot
    /// be told (no home folder).
    fn skills_dir(
        &self,
        scope: Scope,
        workspace: Option<WorkspaceId>,
        repository: Option<RepositoryId>,
    ) -> Result<PathBuf> {
        Ok(match scope {
            Scope::Global => std::env::var_os("HOME")
                .map(|home| PathBuf::from(home).join(".agents/skills"))
                .ok_or_else(|| io("there is no home folder".into()))?,
            Scope::Workspace => self
                .workspace_dir(workspace.ok_or_else(|| invalid("choose a workspace"))?)
                .join("skills"),
            Scope::Project => self
                .project_root(repository.ok_or_else(|| invalid("choose a repository"))?)?
                .join(".agents/skills"),
        })
    }

    fn mcp_file(
        &self,
        scope: Scope,
        workspace: Option<WorkspaceId>,
        repository: Option<RepositoryId>,
    ) -> Result<PathBuf> {
        Ok(match scope {
            Scope::Global => user_config_dir()
                .ok_or_else(|| io("there is no home folder".into()))?
                .join("mcp.json"),
            Scope::Workspace => self
                .workspace_dir(workspace.ok_or_else(|| invalid("choose a workspace"))?)
                .join("mcp.json"),
            Scope::Project => self
                .project_root(repository.ok_or_else(|| invalid("choose a repository"))?)?
                .join(".mcp.json"),
        })
    }

    // ------------------------------------------------------------------ listing

    /// Everything that applies at `context.scope`: what its own definitions add to what the
    /// broader scopes define, each with what this scope says and what that comes to.
    pub fn list(&self, context: Context) -> Result<ResourceList> {
        let chain = self.chain(context.workspace_id, context.repository_id, context.scope);
        let layers: Vec<(Scope, Marks)> = chain
            .iter()
            .map(|(scope, key)| (*scope, self.marks(key)))
            .collect();
        let mut out = ResourceList::default();
        let mut skills: BTreeMap<String, (String, Scope)> = BTreeMap::new();
        let mut mcps: BTreeMap<String, (String, Scope)> = BTreeMap::new();
        for (scope, _) in &chain {
            let dir = self.skills_dir(*scope, context.workspace_id, context.repository_id);
            if let Some(dir) = dir.ok().filter(|dir| dir.is_dir()) {
                let mut found = BTreeMap::new();
                collect_skills(&dir, &mut found);
                for (id, skill) in found {
                    skills.insert(id, (skill.description, *scope));
                }
            }
            if let Ok(file) = self.mcp_file(*scope, context.workspace_id, context.repository_id) {
                match read_mcp_entries(&file) {
                    Ok(Some((entries, _))) => {
                        for (name, config) in entries {
                            mcps.insert(name, (mcp_summary(&config), *scope));
                        }
                    }
                    Ok(None) => {}
                    Err(error) => out.problems.push(error.message),
                }
            }
        }
        let resolve =
            |kind: Kind, id: &str, description: String, defined_in: Scope| -> ResourceItem {
                let says = |layer: &Marks| {
                    layer
                        .map(kind)
                        .get(id)
                        .filter(|state| *state != "inherit")
                        .cloned()
                };
                let own = layers
                    .last()
                    .and_then(|(_, layer)| layer.map(kind).get(id).cloned());
                // What the scopes below this one come to: the narrowest that spoke.
                let below = layers[..layers.len().saturating_sub(1)]
                    .iter()
                    .rev()
                    .find_map(|(scope, layer)| says(layer).map(|state| (*scope, state)));
                let inherited = below.as_ref().is_none_or(|(_, state)| state == "on");
                let effective = match own.as_deref() {
                    Some("on") => true,
                    Some("off") => false,
                    _ => inherited,
                };
                ResourceItem {
                    id: id.to_string(),
                    kind,
                    description,
                    defined_in,
                    state: own.unwrap_or_else(|| "inherit".into()),
                    effective,
                    inherited,
                    inherited_from: below.map(|(scope, _)| scope),
                }
            };
        out.skills = skills
            .into_iter()
            .map(|(id, (text, scope))| resolve(Kind::Skill, &id, text, scope))
            .collect();
        out.mcps = mcps
            .into_iter()
            .map(|(id, (text, scope))| resolve(Kind::Mcp, &id, text, scope))
            .collect();
        Ok(out)
    }

    // ------------------------------------------------------------------ skills

    pub fn read_skill(&self, context: Context, id: &str) -> Result<SkillText> {
        if !valid_skill_id(id) {
            return Err(invalid("that is not a skill name"));
        }
        let dir = self
            .skills_dir(context.scope, context.workspace_id, context.repository_id)?
            .join(id);
        let file = dir.join("SKILL.md");
        let skill = parse_skill(&file, &dir)
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "this scope has no such skill"))?;
        let text = fs::read_to_string(&file).map_err(|error| io(error.to_string()))?;
        let mut lines = text.lines();
        // Skip the frontmatter to reach the instructions.
        if lines.next().is_some_and(|line| line.trim_end() == "---") {
            for line in lines.by_ref() {
                if line.trim_end() == "---" {
                    break;
                }
            }
        }
        let body = lines
            .collect::<Vec<_>>()
            .join("\n")
            .trim_matches('\n')
            .to_string();
        Ok(SkillText {
            description: skill.description,
            body,
        })
    }

    /// Writes `SKILL.md` for a skill of this scope; `replace` is for editing one that exists.
    pub fn save_skill(
        &self,
        context: Context,
        id: &str,
        description: &str,
        body: &str,
        replace: bool,
    ) -> Result<()> {
        if !valid_skill_id(id) {
            return Err(invalid(
                "a skill name is lowercase letters, digits and dashes, up to 64 characters",
            ));
        }
        let description = description.split_whitespace().collect::<Vec<_>>().join(" ");
        if description.is_empty() || description.chars().count() > 1024 {
            return Err(invalid(
                "describe what the skill is for, in up to 1024 characters",
            ));
        }
        let dir = self
            .skills_dir(context.scope, context.workspace_id, context.repository_id)?
            .join(id);
        let exists = dir.join("SKILL.md").exists();
        if exists && !replace {
            return Err(invalid(format!(
                "this scope already has a skill called `{id}`"
            )));
        }
        if !exists && replace {
            return Err(Error::new(
                ErrorCode::NotFound,
                "this scope has no such skill",
            ));
        }
        fs::create_dir_all(&dir)
            .map_err(|error| io(format!("could not create {}: {error}", dir.display())))?;
        let text = format!(
            "---\nname: {id}\ndescription: >\n  {description}\n---\n\n{}\n",
            body.trim_end()
        );
        fs::write(dir.join("SKILL.md"), text)
            .map_err(|error| io(format!("could not write the skill: {error}")))?;
        Ok(())
    }

    /// Deletes a skill this scope defines. Marks other scopes made about it are left alone.
    pub fn delete_skill(&self, context: Context, id: &str) -> Result<()> {
        if !valid_skill_id(id) {
            return Err(invalid("that is not a skill name"));
        }
        let dir = self
            .skills_dir(context.scope, context.workspace_id, context.repository_id)?
            .join(id);
        if !dir.join("SKILL.md").is_file() {
            return Err(Error::new(
                ErrorCode::NotFound,
                "this scope has no such skill",
            ));
        }
        fs::remove_dir_all(&dir).map_err(|error| io(format!("could not delete the skill: {error}")))
    }

    // ------------------------------------------------------------------ MCP servers

    fn read_servers(&self, file: &Path) -> Result<Map<String, Value>> {
        Ok(read_mcp_entries(file)?
            .map(|(entries, _)| entries)
            .unwrap_or_default())
    }

    fn write_servers(&self, file: &Path, servers: &Map<String, Value>) -> Result<()> {
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| io(format!("could not create {}: {error}", parent.display())))?;
        }
        let bytes = serde_json::to_vec_pretty(&serde_json::json!({ "mcpServers": servers }))
            .map_err(|error| invalid(error.to_string()))?;
        fs::write(file, bytes)
            .map_err(|error| io(format!("could not write {}: {error}", file.display())))?;
        // Servers carry tokens in their environment: the files the app owns are private.
        #[cfg(unix)]
        if !matches!(self.is_repository_file(file), Some(true)) {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(file, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    /// A `.mcp.json` of a repository is shared with its team and keeps its permissions.
    fn is_repository_file(&self, file: &Path) -> Option<bool> {
        Some(file.file_name()?.to_str()? == ".mcp.json")
    }

    pub fn read_mcp(&self, context: Context, name: &str) -> Result<Value> {
        let file = self.mcp_file(context.scope, context.workspace_id, context.repository_id)?;
        self.read_servers(&file)?
            .get(name)
            .cloned()
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "this scope has no such MCP server"))
    }

    /// Adds or replaces an MCP server in this scope's file.
    pub fn save_mcp(
        &self,
        context: Context,
        name: &str,
        config: Value,
        replace: bool,
    ) -> Result<()> {
        if !valid_mcp_name(name) {
            return Err(invalid(
                "a server name is letters, digits, dots, dashes and underscores",
            ));
        }
        let file = self.mcp_file(context.scope, context.workspace_id, context.repository_id)?;
        validate_mcp_server(&file, name, &config)?;
        let mut servers = self.read_servers(&file)?;
        match (servers.contains_key(name), replace) {
            (true, false) => {
                return Err(invalid(format!(
                    "this scope already has a server called `{name}`"
                )));
            }
            (false, true) => {
                return Err(Error::new(
                    ErrorCode::NotFound,
                    "this scope has no such MCP server",
                ));
            }
            _ => {}
        }
        servers.insert(name.to_string(), config);
        self.write_servers(&file, &servers)
    }

    pub fn delete_mcp(&self, context: Context, name: &str) -> Result<()> {
        let file = self.mcp_file(context.scope, context.workspace_id, context.repository_id)?;
        let mut servers = self.read_servers(&file)?;
        if servers.remove(name).is_none() {
            return Err(Error::new(
                ErrorCode::NotFound,
                "this scope has no such MCP server",
            ));
        }
        self.write_servers(&file, &servers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::sqlite::SqliteStore;
    use crate::domain::Repository;
    use serde_json::json;

    struct Fixture {
        manager: ResourceManager,
        workspace: WorkspaceId,
        repository: RepositoryId,
        root: PathBuf,
        _dirs: (tempfile::TempDir, tempfile::TempDir),
    }

    fn fixture() -> Fixture {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(project.path().join(".git")).unwrap();
        let store = Arc::new(SqliteStore::open(&data.path().join("db.sqlite3")).unwrap());
        let repository = RepositoryId::new();
        store
            .upsert_repository(&Repository {
                id: repository,
                root: project.path().to_path_buf(),
                name: "p".into(),
                created_at: "2026-01-01T00:00:00Z".into(),
                updated_at: "2026-01-01T00:00:00Z".into(),
            })
            .unwrap();
        Fixture {
            manager: ResourceManager::new(store, data.path().to_path_buf()),
            workspace: WorkspaceId::new(),
            repository,
            root: project.path().to_path_buf(),
            _dirs: (data, project),
        }
    }

    fn at(f: &Fixture, scope: Scope) -> Context {
        Context {
            scope,
            workspace_id: Some(f.workspace),
            repository_id: Some(f.repository),
        }
    }

    fn item<'a>(list: &'a [ResourceItem], id: &str) -> &'a ResourceItem {
        list.iter()
            .find(|item| item.id == id)
            .unwrap_or_else(|| panic!("no {id}"))
    }

    #[test]
    fn skills_are_defined_per_scope_and_the_narrowest_mark_wins() {
        let f = fixture();
        f.manager
            .save_skill(
                at(&f, Scope::Workspace),
                "review-style",
                "How we review",
                "Be kind.",
                false,
            )
            .unwrap();
        f.manager
            .save_skill(
                at(&f, Scope::Project),
                "deploy",
                "How to deploy",
                "Run it.",
                false,
            )
            .unwrap();
        assert!(f.root.join(".agents/skills/deploy/SKILL.md").is_file());

        // The project sees both; the workspace only its own.
        let project = f.manager.list(at(&f, Scope::Project)).unwrap();
        assert_eq!(item(&project.skills, "deploy").defined_in, Scope::Project);
        assert_eq!(
            item(&project.skills, "review-style").defined_in,
            Scope::Workspace
        );
        let workspace = f.manager.list(at(&f, Scope::Workspace)).unwrap();
        assert!(workspace.skills.iter().all(|skill| skill.id != "deploy"));

        // Nobody mentioned them: on.
        assert!(item(&project.skills, "review-style").effective);
        assert_eq!(item(&project.skills, "review-style").state, "inherit");

        // Off in the workspace reaches the project, unless the project says otherwise.
        f.manager
            .set_state(at(&f, Scope::Workspace), Kind::Skill, "review-style", "off")
            .unwrap();
        let project = f.manager.list(at(&f, Scope::Project)).unwrap();
        let shown = item(&project.skills, "review-style");
        assert!(!shown.effective && !shown.inherited);
        assert_eq!(shown.inherited_from, Some(Scope::Workspace));
        let policy = f.manager.policy_for(Some(f.workspace), f.repository);
        assert!(policy.disabled_skills.contains("review-style"));

        f.manager
            .set_state(at(&f, Scope::Project), Kind::Skill, "review-style", "on")
            .unwrap();
        let project = f.manager.list(at(&f, Scope::Project)).unwrap();
        assert!(item(&project.skills, "review-style").effective);
        assert!(
            !f.manager
                .policy_for(Some(f.workspace), f.repository)
                .disabled_skills
                .contains("review-style")
        );

        // Back to inherit: the workspace's off applies again.
        f.manager
            .set_state(
                at(&f, Scope::Project),
                Kind::Skill,
                "review-style",
                "inherit",
            )
            .unwrap();
        assert!(
            f.manager
                .policy_for(Some(f.workspace), f.repository)
                .disabled_skills
                .contains("review-style")
        );
        assert!(
            f.manager
                .set_state(at(&f, Scope::Global), Kind::Skill, "x", "inherit")
                .is_err()
        );
        assert!(
            f.manager
                .set_state(at(&f, Scope::Project), Kind::Skill, "x", "maybe")
                .is_err()
        );
    }

    #[test]
    fn a_skill_is_written_read_edited_and_deleted() {
        let f = fixture();
        let scope = at(&f, Scope::Workspace);
        f.manager
            .save_skill(
                scope,
                "notes",
                "Take\nnotes   well",
                "# Steps\n\n1. Write",
                false,
            )
            .unwrap();
        let read = f.manager.read_skill(scope, "notes").unwrap();
        assert_eq!(read.description, "Take notes well");
        assert_eq!(read.body, "# Steps\n\n1. Write");
        assert!(
            f.manager
                .save_skill(scope, "notes", "again", "", false)
                .is_err()
        );
        f.manager
            .save_skill(scope, "notes", "Changed", "New body", true)
            .unwrap();
        assert_eq!(
            f.manager.read_skill(scope, "notes").unwrap().body,
            "New body"
        );
        assert!(
            f.manager
                .save_skill(scope, "missing", "x", "", true)
                .is_err()
        );
        for bad in ["Has Caps", "../escape", "", "-x", "a b"] {
            assert!(
                f.manager.save_skill(scope, bad, "d", "", false).is_err(),
                "{bad:?}"
            );
        }
        assert!(f.manager.save_skill(scope, "ok", "  ", "", false).is_err());
        f.manager.delete_skill(scope, "notes").unwrap();
        assert!(f.manager.read_skill(scope, "notes").is_err());
        assert!(f.manager.delete_skill(scope, "../etc").is_err());
    }

    #[test]
    fn mcp_servers_are_defined_per_scope_without_showing_their_secrets() {
        let f = fixture();
        let config =
            json!({"command": "npx", "args": ["-y", "server"], "env": {"TOKEN": "s3cret"}});
        f.manager
            .save_mcp(at(&f, Scope::Workspace), "docs", config.clone(), false)
            .unwrap();
        f.manager
            .save_mcp(
                at(&f, Scope::Project),
                "db",
                json!({"url": "https://example.com/mcp"}),
                false,
            )
            .unwrap();
        assert!(f.root.join(".mcp.json").is_file());
        assert!(
            f.manager
                .save_mcp(at(&f, Scope::Workspace), "docs", config.clone(), false)
                .is_err()
        );
        assert!(
            f.manager
                .save_mcp(
                    at(&f, Scope::Workspace),
                    "bad",
                    json!({"command": "x", "url": "y"}),
                    false
                )
                .is_err()
        );
        assert!(
            f.manager
                .save_mcp(at(&f, Scope::Workspace), "../x", config.clone(), false)
                .is_err()
        );

        let listed = f.manager.list(at(&f, Scope::Project)).unwrap();
        assert_eq!(item(&listed.mcps, "docs").description, "npx -y server");
        assert!(!serde_json::to_string(&listed).unwrap().contains("s3cret"));
        assert_eq!(item(&listed.mcps, "db").defined_in, Scope::Project);
        assert_eq!(
            f.manager
                .read_mcp(at(&f, Scope::Workspace), "docs")
                .unwrap(),
            config
        );

        f.manager
            .set_state(at(&f, Scope::Project), Kind::Mcp, "docs", "off")
            .unwrap();
        assert!(
            f.manager
                .policy_for(Some(f.workspace), f.repository)
                .disabled_mcps
                .contains("docs")
        );
        f.manager
            .delete_mcp(at(&f, Scope::Workspace), "docs")
            .unwrap();
        assert!(
            f.manager
                .list(at(&f, Scope::Project))
                .unwrap()
                .mcps
                .iter()
                .all(|item| item.id != "docs")
        );
    }

    #[test]
    fn the_agent_gets_the_workspace_resources_and_loses_what_is_off() {
        use crate::adapters::agents::config::AgentConfiguration;
        use crate::domain::ids::SessionId;
        let f = fixture();
        f.manager
            .save_skill(
                at(&f, Scope::Workspace),
                "ws-skill",
                "From the workspace",
                "x",
                false,
            )
            .unwrap();
        f.manager
            .save_skill(at(&f, Scope::Project), "gone", "Switched off", "x", false)
            .unwrap();
        f.manager
            .save_mcp(
                at(&f, Scope::Workspace),
                "ws-mcp",
                json!({"command": "echo"}),
                false,
            )
            .unwrap();
        f.manager
            .set_state(at(&f, Scope::Project), Kind::Skill, "gone", "off")
            .unwrap();
        let policy = f.manager.policy_for(Some(f.workspace), f.repository);
        let config =
            AgentConfiguration::load_with(&f.root, SessionId::new(), None, None, &policy).unwrap();
        let ids: Vec<&str> = config
            .skills
            .iter()
            .map(|skill| skill.id.as_str())
            .collect();
        assert!(ids.contains(&"ws-skill"), "{ids:?}");
        assert!(!ids.contains(&"gone"), "{ids:?}");
        assert!(config.mcp_servers.contains_key("ws-mcp"));
    }
}
