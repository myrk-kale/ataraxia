//! What the agents remember: the rules for writing, finding and tidying memories, over the
//! [`Store`] port. The same rules serve an agent (through the MCP tools) and the developer
//! (through Settings), with two differences: an agent sees only the global memories and those of
//! its own workspace, and an agent may not put something in the developer's global memory that the
//! developer did not say.

use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use crate::domain::ids::WorkspaceId;
use crate::domain::memory::{WORKING_DAYS, clean_body, clean_tags, clean_title, refuse_secrets};
use crate::domain::time::{in_days, is_moment, now_rfc3339};
use crate::domain::{
    Error, ErrorCode, Memory, MemoryAuthor, MemoryKind, MemoryLink, MemorySource, Relation, Result,
};
use crate::ports::Store;

/// The preference that switches memory off. Anything but `false` leaves it on.
pub const ENABLED_KEY: &str = "memory.enabled";

pub fn enabled(store: &dyn Store) -> bool {
    store
        .get_preference(ENABLED_KEY)
        .ok()
        .flatten()
        .is_none_or(|value| value != "false")
}

pub fn set_enabled(store: &dyn Store, on: bool) -> Result<()> {
    store.set_preference(ENABLED_KEY, if on { "true" } else { "false" })
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorCode::Invalid, message)
}

fn not_found(id: &str) -> Error {
    Error::new(ErrorCode::NotFound, format!("no memory with id {id}"))
}

/// Who is asking, and so what they may see and do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Viewer {
    pub author: MemoryAuthor,
    /// The workspace of the chat an agent speaks from. Unused for the developer.
    pub workspace: Option<WorkspaceId>,
}

impl Viewer {
    pub fn agent(workspace: Option<WorkspaceId>) -> Self {
        Self {
            author: MemoryAuthor::Agent,
            workspace,
        }
    }

    pub fn developer() -> Self {
        Self {
            author: MemoryAuthor::Developer,
            workspace: None,
        }
    }

    fn sees(&self, memory: &Memory) -> bool {
        match self.author {
            MemoryAuthor::Developer => true,
            MemoryAuthor::Agent => {
                memory.workspace_id.is_none() || memory.workspace_id == self.workspace
            }
        }
    }

    /// Where this viewer may put a memory: an agent only in its own workspace, or in the global
    /// one when the developer said it.
    fn check_scope(&self, workspace: Option<WorkspaceId>, source: MemorySource) -> Result<()> {
        if self.author == MemoryAuthor::Developer {
            return Ok(());
        }
        match workspace {
            None if source != MemorySource::User => Err(invalid(
                "a global memory holds only what the developer said, in so many words: use source \"user\" for that, or save it in the workspace",
            )),
            None => Ok(()),
            Some(workspace) if self.workspace == Some(workspace) => Ok(()),
            Some(_) => Err(invalid("a memory can only go to this chat's workspace")),
        }
    }
}

// ------------------------------------------------------------------ words

const STOP_WORDS: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "into", "are", "was", "not", "but", "use",
    "uses", "used", "que", "para", "com", "uma", "uns", "umas", "dos", "das", "nos", "nas", "por",
    "como", "mais", "foi", "sao", "ser",
];

fn fold(ch: char) -> char {
    match ch {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        other => other,
    }
}

/// The lowercase words of a text, without accents or filler, in order and without repeats.
pub fn words(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    text.to_lowercase()
        .chars()
        .map(fold)
        .collect::<String>()
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|word| word.chars().count() >= 2 && !STOP_WORDS.contains(word))
        .filter(|word| seen.insert(word.to_string()))
        .map(str::to_string)
        .collect()
}

fn field_score(query: &str, field: &HashSet<String>, exact: f32, prefix: f32) -> f32 {
    if field.contains(query) {
        return exact;
    }
    if query.chars().count() >= 3 && field.iter().any(|word| word.starts_with(query)) {
        return prefix;
    }
    0.0
}

/// How well a memory answers a query: its title and tags weigh most, the body least, and a memory
/// that matches more of the words beats one that matches a word well.
fn score(query: &[String], memory: &Memory) -> f32 {
    if query.is_empty() {
        return 0.0;
    }
    let title: HashSet<String> = words(&memory.title).into_iter().collect();
    let tags: HashSet<String> = memory.tags.iter().flat_map(|tag| words(tag)).collect();
    let body: HashSet<String> = words(&memory.body).into_iter().collect();
    let (mut total, mut matched) = (0.0, 0);
    for word in query {
        let best = field_score(word, &title, 4.0, 3.0)
            .max(field_score(word, &tags, 4.0, 2.0))
            .max(field_score(word, &body, 1.0, 0.5));
        if best > 0.0 {
            matched += 1;
            total += best;
        }
    }
    if matched == 0 {
        return 0.0;
    }
    total * (0.4 + 0.6 * matched as f32 / query.len() as f32)
}

// ------------------------------------------------------------------ reading

#[derive(Debug, Clone, Default)]
pub struct Query {
    pub text: String,
    pub kinds: Vec<MemoryKind>,
    pub tag: Option<String>,
    /// Only memories of this workspace (`Some(None)` only the global ones).
    pub workspace: Option<Option<WorkspaceId>>,
    pub include_expired: bool,
    pub limit: usize,
}

#[derive(Debug, Clone)]
pub struct Hit {
    pub memory: Memory,
    pub score: f32,
}

/// The memories that answer `query` among those the viewer sees, best first. With no words in the
/// query they are the most recently changed.
pub fn search(store: &dyn Store, viewer: Viewer, query: &Query) -> Result<Vec<Hit>> {
    let wanted = words(&query.text);
    let tag = query.tag.as_deref().map(str::to_lowercase);
    let mut hits: Vec<Hit> = store
        .memories_all()?
        .into_iter()
        .filter(|memory| viewer.sees(memory))
        .filter(|memory| query.include_expired || !memory.is_expired())
        .filter(|memory| query.kinds.is_empty() || query.kinds.contains(&memory.kind))
        .filter(|memory| tag.as_ref().is_none_or(|tag| memory.tags.contains(tag)))
        .filter(|memory| {
            query
                .workspace
                .is_none_or(|workspace| memory.workspace_id == workspace)
        })
        .filter_map(|memory| {
            let score = score(&wanted, &memory);
            (wanted.is_empty() || score > 0.0).then_some(Hit { memory, score })
        })
        .collect();
    // The store lists the most recently changed first, and the sort is stable.
    hits.sort_by(|a, b| b.score.total_cmp(&a.score));
    hits.truncate(query.limit.max(1));
    Ok(hits)
}

#[derive(Debug, Clone)]
pub struct Neighbor {
    pub link: MemoryLink,
    /// The memory at the other end of the link.
    pub other: Memory,
    /// Whether the viewed memory is the source of the link.
    pub outgoing: bool,
}

#[derive(Debug, Clone)]
pub struct Detail {
    pub memory: Memory,
    pub neighbors: Vec<Neighbor>,
}

fn visible(store: &dyn Store, viewer: Viewer, id: &str) -> Result<Memory> {
    store
        .memory_get(id)?
        .filter(|memory| viewer.sees(memory))
        .ok_or_else(|| not_found(id))
}

pub fn get(store: &dyn Store, viewer: Viewer, id: &str) -> Result<Detail> {
    let memory = visible(store, viewer, id)?;
    let by_id: HashMap<String, Memory> = store
        .memories_all()?
        .into_iter()
        .filter(|other| viewer.sees(other))
        .map(|other| (other.id.clone(), other))
        .collect();
    let neighbors = store
        .memory_links_all()?
        .into_iter()
        .filter_map(|link| {
            let outgoing = link.from_id == id;
            if !outgoing && link.to_id != id {
                return None;
            }
            let other = by_id
                .get(if outgoing { &link.to_id } else { &link.from_id })?
                .clone();
            Some(Neighbor {
                link,
                other,
                outgoing,
            })
        })
        .collect();
    Ok(Detail { memory, neighbors })
}

#[derive(Debug, Clone, Default)]
pub struct Graph {
    pub memories: Vec<Memory>,
    pub links: Vec<MemoryLink>,
}

/// Every memory the viewer sees, with the links between them.
pub fn graph(store: &dyn Store, viewer: Viewer) -> Result<Graph> {
    let memories: Vec<Memory> = store
        .memories_all()?
        .into_iter()
        .filter(|memory| viewer.sees(memory))
        .collect();
    let ids: HashSet<&str> = memories.iter().map(|memory| memory.id.as_str()).collect();
    let links = store
        .memory_links_all()?
        .into_iter()
        .filter(|link| ids.contains(link.from_id.as_str()) && ids.contains(link.to_id.as_str()))
        .collect();
    Ok(Graph { memories, links })
}

/// Memories that already say what a new one is about: they share most of its title and tags.
fn similar(store: &dyn Store, viewer: Viewer, title: &str, tags: &[String]) -> Result<Vec<Memory>> {
    let mine: HashSet<String> = words(title)
        .into_iter()
        .chain(tags.iter().flat_map(|tag| words(tag)))
        .collect();
    if mine.is_empty() {
        return Ok(Vec::new());
    }
    let mut found: Vec<(f32, Memory)> = store
        .memories_all()?
        .into_iter()
        .filter(|memory| viewer.sees(memory) && !memory.is_expired())
        .filter_map(|memory| {
            let theirs: HashSet<String> = words(&memory.title)
                .into_iter()
                .chain(memory.tags.iter().flat_map(|tag| words(tag)))
                .collect();
            let shared = mine.intersection(&theirs).count() as f32;
            let overlap = shared / (mine.len() + theirs.len()) as f32 * 2.0;
            (shared >= 2.0 && overlap >= 0.5).then_some((overlap, memory))
        })
        .collect();
    found.sort_by(|a, b| b.0.total_cmp(&a.0));
    Ok(found
        .into_iter()
        .take(3)
        .map(|(_, memory)| memory)
        .collect())
}

// ------------------------------------------------------------------ writing

#[derive(Debug, Clone)]
pub struct NewMemory {
    pub kind: MemoryKind,
    pub workspace_id: Option<WorkspaceId>,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub source: MemorySource,
    pub expires_at: Option<String>,
    pub links: Vec<(String, Relation)>,
}

#[derive(Debug, Clone)]
pub struct Created {
    pub memory: Memory,
    /// Memories that look like the new one, for the writer to merge or relate.
    pub similar: Vec<Memory>,
}

fn clean_expiry(expires_at: Option<&str>) -> Result<Option<String>> {
    match expires_at {
        None => Ok(None),
        Some(moment) if is_moment(moment) => Ok(Some(moment.to_string())),
        Some(_) => Err(invalid(
            "expires_at must be a date and time such as 2026-12-31T00:00:00Z",
        )),
    }
}

fn check_text(title: &str, body: &str) -> Result<(String, String)> {
    let title = clean_title(title)?;
    let body = clean_body(body)?;
    refuse_secrets(&title)?;
    refuse_secrets(&body)?;
    Ok((title, body))
}

pub fn create(store: &dyn Store, viewer: Viewer, new: NewMemory) -> Result<Created> {
    viewer.check_scope(new.workspace_id, new.source)?;
    let (title, body) = check_text(&new.title, &new.body)?;
    let tags = clean_tags(&new.tags)?;
    for tag in &tags {
        refuse_secrets(tag)?;
    }
    let expires_at = match (clean_expiry(new.expires_at.as_deref())?, new.kind) {
        (None, MemoryKind::Working) => Some(in_days(WORKING_DAYS)?),
        (expiry, _) => expiry,
    };
    // The links are checked before anything is written.
    for (target, _) in &new.links {
        visible(store, viewer, target)?;
    }
    let similar = similar(store, viewer, &title, &tags)?;
    let now = now_rfc3339()?;
    let memory = Memory {
        id: Uuid::new_v4().to_string(),
        kind: new.kind,
        workspace_id: new.workspace_id,
        title,
        body,
        tags,
        source: new.source,
        author: viewer.author,
        expires_at,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    store.memory_put(&memory)?;
    for (target, relation) in new.links {
        store.memory_link_put(&MemoryLink {
            from_id: memory.id.clone(),
            to_id: target,
            relation,
            created_at: now.clone(),
        })?;
    }
    Ok(Created { memory, similar })
}

/// What a caller changes in a memory; what is `None` stays as it is.
#[derive(Debug, Clone, Default)]
pub struct Patch {
    pub kind: Option<MemoryKind>,
    pub workspace_id: Option<Option<WorkspaceId>>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub tags: Option<Vec<String>>,
    pub source: Option<MemorySource>,
    /// `Some(None)` removes the expiry.
    pub expires_at: Option<Option<String>>,
}

fn patched(viewer: Viewer, current: &Memory, patch: Patch) -> Result<Memory> {
    let mut memory = current.clone();
    if let Some(kind) = patch.kind {
        memory.kind = kind;
    }
    if let Some(source) = patch.source {
        memory.source = source;
    }
    if let Some(workspace) = patch.workspace_id {
        memory.workspace_id = workspace;
    }
    // The destination is checked even when only the source changed: a memory cannot be made
    // global by an agent unless the developer said it.
    viewer.check_scope(memory.workspace_id, memory.source)?;
    let (title, body) = check_text(
        patch.title.as_deref().unwrap_or(&memory.title),
        patch.body.as_deref().unwrap_or(&memory.body),
    )?;
    memory.title = title;
    memory.body = body;
    if let Some(tags) = patch.tags {
        memory.tags = clean_tags(&tags)?;
    }
    match patch.expires_at {
        Some(Some(moment)) => memory.expires_at = clean_expiry(Some(&moment))?,
        Some(None) => memory.expires_at = None,
        None => {}
    }
    if memory.kind == MemoryKind::Working && memory.expires_at.is_none() {
        memory.expires_at = Some(in_days(WORKING_DAYS)?);
    }
    memory.updated_at = now_rfc3339()?;
    Ok(memory)
}

pub fn update(store: &dyn Store, viewer: Viewer, id: &str, patch: Patch) -> Result<Memory> {
    let current = visible(store, viewer, id)?;
    let memory = patched(viewer, &current, patch)?;
    store.memory_put(&memory)?;
    Ok(memory)
}

pub fn delete(store: &dyn Store, viewer: Viewer, id: &str) -> Result<()> {
    visible(store, viewer, id)?;
    store.memory_remove(id)?;
    Ok(())
}

pub fn link(
    store: &dyn Store,
    viewer: Viewer,
    from: &str,
    to: &str,
    relation: Relation,
) -> Result<MemoryLink> {
    if from == to {
        return Err(invalid("a memory cannot be linked to itself"));
    }
    visible(store, viewer, from)?;
    visible(store, viewer, to)?;
    let link = MemoryLink {
        from_id: from.to_string(),
        to_id: to.to_string(),
        relation,
        created_at: now_rfc3339()?,
    };
    // `a relates_to b` and `b relates_to a` are the same thing: keep one.
    if relation.symmetric() {
        let reverse = store.memory_links_all()?.into_iter().any(|existing| {
            existing.relation == relation && existing.from_id == to && existing.to_id == from
        });
        if reverse {
            return Ok(MemoryLink {
                from_id: to.to_string(),
                to_id: from.to_string(),
                ..link
            });
        }
    }
    store.memory_link_put(&link)?;
    Ok(link)
}

pub fn unlink(
    store: &dyn Store,
    viewer: Viewer,
    from: &str,
    to: &str,
    relation: Relation,
) -> Result<()> {
    visible(store, viewer, from)?;
    visible(store, viewer, to)?;
    let removed = store.memory_link_remove(from, to, relation)?
        || (relation.symmetric() && store.memory_link_remove(to, from, relation)?);
    if removed {
        Ok(())
    } else {
        Err(Error::new(
            ErrorCode::NotFound,
            "those memories are not linked that way",
        ))
    }
}

/// Folds `absorbed` into `into`: `into` takes the given text, inherits the links and the others
/// are deleted. It is how two memories that say the same, or disagree, become one.
pub fn merge(
    store: &dyn Store,
    viewer: Viewer,
    into: &str,
    absorbed: &[String],
    patch: Patch,
) -> Result<Memory> {
    if absorbed.is_empty() {
        return Err(invalid("merge needs at least one memory to fold in"));
    }
    if absorbed.iter().any(|id| id == into) {
        return Err(invalid("a memory cannot be folded into itself"));
    }
    let current = visible(store, viewer, into)?;
    for id in absorbed {
        visible(store, viewer, id)?;
    }
    let memory = patched(viewer, &current, patch)?;
    store.memory_merge(&memory, absorbed)?;
    Ok(memory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::sqlite::SqliteStore;

    fn new(title: &str, body: &str) -> NewMemory {
        NewMemory {
            kind: MemoryKind::Semantic,
            workspace_id: None,
            title: title.into(),
            body: body.into(),
            tags: vec![],
            source: MemorySource::User,
            expires_at: None,
            links: vec![],
        }
    }

    fn ask(text: &str) -> Query {
        Query {
            text: text.into(),
            limit: 10,
            ..Query::default()
        }
    }

    fn titles(hits: &[Hit]) -> Vec<&str> {
        hits.iter().map(|hit| hit.memory.title.as_str()).collect()
    }

    #[test]
    fn search_ranks_the_title_over_the_body_and_ignores_accents_and_case() {
        let store = SqliteStore::open_in_memory().unwrap();
        let developer = Viewer::developer();
        create(
            &store,
            developer,
            new("Prefiro Python", "para automações de build"),
        )
        .unwrap();
        create(
            &store,
            developer,
            new("Build tool", "automações usam Python quando possível"),
        )
        .unwrap();
        create(&store, developer, new("Deploy", "sempre pelo pipeline")).unwrap();
        let hits = search(&store, developer, &ask("PYTHON automacoes")).unwrap();
        assert_eq!(titles(&hits), vec!["Prefiro Python", "Build tool"]);
        assert!(
            search(&store, developer, &ask("kubernetes"))
                .unwrap()
                .is_empty()
        );
        // A prefix finds the word, and no words at all lists the latest first.
        assert_eq!(
            titles(&search(&store, developer, &ask("deplo")).unwrap()),
            vec!["Deploy"]
        );
        assert_eq!(search(&store, developer, &ask("")).unwrap().len(), 3);
    }

    #[test]
    fn an_agent_sees_global_and_its_own_workspace_and_nothing_else() {
        let store = SqliteStore::open_in_memory().unwrap();
        let (mine, other) = (WorkspaceId::new(), WorkspaceId::new());
        let developer = Viewer::developer();
        create(&store, developer, new("Global note", "everywhere")).unwrap();
        for (workspace, title) in [(mine, "Mine note"), (other, "Theirs note")] {
            create(
                &store,
                developer,
                NewMemory {
                    workspace_id: Some(workspace),
                    ..new(title, "x")
                },
            )
            .unwrap();
        }
        let agent = Viewer::agent(Some(mine));
        let seen = search(&store, agent, &ask("note")).unwrap();
        let mut names = titles(&seen);
        names.sort();
        assert_eq!(names, vec!["Global note", "Mine note"]);
        let theirs = search(&store, developer, &ask("theirs")).unwrap()[0]
            .memory
            .id
            .clone();
        assert_eq!(
            get(&store, agent, &theirs).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            delete(&store, agent, &theirs).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(graph(&store, agent).unwrap().memories.len(), 2);
        // A chat with no workspace sees only what is global.
        assert_eq!(
            search(&store, Viewer::agent(None), &ask("note"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn an_agent_cannot_write_to_the_global_memory_unless_the_developer_said_it() {
        let store = SqliteStore::open_in_memory().unwrap();
        let workspace = WorkspaceId::new();
        let agent = Viewer::agent(Some(workspace));
        let inferred = NewMemory {
            source: MemorySource::Inferred,
            ..new("Likes tabs", "seems so")
        };
        assert!(create(&store, agent, inferred).is_err());
        assert!(create(&store, agent, new("Prefers tabs", "said so")).is_ok());
        let elsewhere = NewMemory {
            workspace_id: Some(WorkspaceId::new()),
            ..new("Not mine", "x")
        };
        assert!(create(&store, agent, elsewhere).is_err());
        let local = NewMemory {
            workspace_id: Some(workspace),
            source: MemorySource::Inferred,
            ..new("Local guess", "x")
        };
        let made = create(&store, agent, local).unwrap().memory;
        // Moving it to the global memory needs the developer's word too.
        let up = Patch {
            workspace_id: Some(None),
            ..Patch::default()
        };
        assert!(update(&store, agent, &made.id, up).is_err());
        let said = Patch {
            workspace_id: Some(None),
            source: Some(MemorySource::User),
            ..Patch::default()
        };
        assert_eq!(
            update(&store, agent, &made.id, said).unwrap().workspace_id,
            None
        );
    }

    #[test]
    fn a_new_memory_reports_the_ones_it_looks_like() {
        let store = SqliteStore::open_in_memory().unwrap();
        let developer = Viewer::developer();
        let first = create(&store, developer, new("Redis chosen for latency", "x")).unwrap();
        assert!(first.similar.is_empty());
        let second = create(
            &store,
            developer,
            new("Chose Redis because of latency", "y"),
        )
        .unwrap();
        assert_eq!(second.similar.len(), 1);
        assert_eq!(second.similar[0].id, first.memory.id);
        let unrelated = create(&store, developer, new("Deploy on Fridays", "never")).unwrap();
        assert!(unrelated.similar.is_empty());
    }

    #[test]
    fn working_memory_expires_and_stops_being_offered() {
        let store = SqliteStore::open_in_memory().unwrap();
        let developer = Viewer::developer();
        let made = create(
            &store,
            developer,
            NewMemory {
                kind: MemoryKind::Working,
                ..new("Fixing login", "in progress")
            },
        )
        .unwrap()
        .memory;
        assert!(made.expires_at.is_some());
        assert_eq!(search(&store, developer, &ask("login")).unwrap().len(), 1);
        let past = Patch {
            expires_at: Some(Some("2020-01-01T00:00:00Z".into())),
            ..Patch::default()
        };
        update(&store, developer, &made.id, past).unwrap();
        assert!(search(&store, developer, &ask("login")).unwrap().is_empty());
        let all = Query {
            include_expired: true,
            ..ask("login")
        };
        assert_eq!(search(&store, developer, &all).unwrap().len(), 1);
        assert!(
            create(
                &store,
                developer,
                NewMemory {
                    expires_at: Some("soon".into()),
                    ..new("a", "b")
                }
            )
            .is_err()
        );
    }

    #[test]
    fn links_join_memories_and_a_symmetric_one_is_kept_once() {
        let store = SqliteStore::open_in_memory().unwrap();
        let developer = Viewer::developer();
        let a = create(&store, developer, new("Cause", "x")).unwrap().memory;
        let b = create(
            &store,
            developer,
            NewMemory {
                links: vec![(a.id.clone(), Relation::CausedBy)],
                ..new("Effect", "y")
            },
        )
        .unwrap()
        .memory;
        let detail = get(&store, developer, &a.id).unwrap();
        assert_eq!(detail.neighbors.len(), 1);
        assert!(!detail.neighbors[0].outgoing);
        assert_eq!(detail.neighbors[0].other.id, b.id);
        link(&store, developer, &a.id, &b.id, Relation::RelatesTo).unwrap();
        link(&store, developer, &b.id, &a.id, Relation::RelatesTo).unwrap();
        assert_eq!(graph(&store, developer).unwrap().links.len(), 2);
        assert!(link(&store, developer, &a.id, &a.id, Relation::RelatesTo).is_err());
        assert!(link(&store, developer, &a.id, "nope", Relation::RelatesTo).is_err());
        unlink(&store, developer, &b.id, &a.id, Relation::RelatesTo).unwrap();
        assert_eq!(graph(&store, developer).unwrap().links.len(), 1);
        assert_eq!(
            unlink(&store, developer, &b.id, &a.id, Relation::RelatesTo)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        delete(&store, developer, &a.id).unwrap();
        assert!(graph(&store, developer).unwrap().links.is_empty());
    }

    #[test]
    fn merging_keeps_one_memory_with_every_link_and_removes_the_rest() {
        let store = SqliteStore::open_in_memory().unwrap();
        let developer = Viewer::developer();
        let keep = create(&store, developer, new("Use pnpm", "v1"))
            .unwrap()
            .memory;
        let dupe = create(&store, developer, new("pnpm is the manager", "v2"))
            .unwrap()
            .memory;
        let why = create(&store, developer, new("Why pnpm", "disk"))
            .unwrap()
            .memory;
        let user = create(&store, developer, new("Monorepo", "yes"))
            .unwrap()
            .memory;
        link(&store, developer, &why.id, &dupe.id, Relation::Supports).unwrap();
        link(&store, developer, &dupe.id, &user.id, Relation::PartOf).unwrap();
        link(&store, developer, &dupe.id, &keep.id, Relation::Contradicts).unwrap();
        let merged = merge(
            &store,
            developer,
            &keep.id,
            std::slice::from_ref(&dupe.id),
            Patch {
                body: Some("pnpm, one version".into()),
                ..Patch::default()
            },
        )
        .unwrap();
        assert_eq!(merged.body, "pnpm, one version");
        let now = graph(&store, developer).unwrap();
        assert_eq!(now.memories.len(), 3);
        let mut links: Vec<(String, String, Relation)> = now
            .links
            .iter()
            .map(|l| (l.from_id.clone(), l.to_id.clone(), l.relation))
            .collect();
        links.sort_by_key(|l| l.2.as_str());
        assert_eq!(
            links,
            vec![
                (keep.id.clone(), user.id.clone(), Relation::PartOf),
                (why.id.clone(), keep.id.clone(), Relation::Supports),
            ],
            "the contradiction with itself is dropped"
        );
        assert!(merge(&store, developer, &keep.id, &[], Patch::default()).is_err());
        assert!(
            merge(
                &store,
                developer,
                &keep.id,
                std::slice::from_ref(&keep.id),
                Patch::default()
            )
            .is_err()
        );
    }

    #[test]
    fn a_secret_is_refused_on_create_and_on_update() {
        let store = SqliteStore::open_in_memory().unwrap();
        let developer = Viewer::developer();
        assert!(
            create(
                &store,
                developer,
                new("Key", "sk-abcdefghijklmnopqrstuvwxyz123456")
            )
            .is_err()
        );
        let ok = create(&store, developer, new("Key location", "in the vault"))
            .unwrap()
            .memory;
        let bad = Patch {
            body: Some("PASSWORD=hunter2hunter2".into()),
            ..Patch::default()
        };
        assert!(update(&store, developer, &ok.id, bad).is_err());
    }

    #[test]
    fn memory_is_on_until_it_is_switched_off() {
        let store = SqliteStore::open_in_memory().unwrap();
        assert!(enabled(&store));
        set_enabled(&store, false).unwrap();
        assert!(!enabled(&store));
        set_enabled(&store, true).unwrap();
        assert!(enabled(&store));
    }
}
