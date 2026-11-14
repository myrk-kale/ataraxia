//! Flow: prompt presets and explicit diagram generation.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::json;
use uuid::Uuid;

use super::analysis::{flow_prompt, parse_flow, structure_summary};
use super::engine::Engine;
use crate::domain::ids::{RepositoryId, SessionId};
use crate::domain::{
    Artifact, ArtifactId, ArtifactKind, ArtifactStatus, CheckpointSource, Error, ErrorCode,
    FlowPreset, FlowPresetId, Result, SessionKind,
};

const MAX_PROMPT_CHARS: usize = 8_000;
const MAX_EXTRA_CHARS: usize = 2_000;

const BUILTIN_PRESETS: &[(u128, &str, &str)] = &[
    (
        1,
        "Execution flow",
        "Trace how execution moves through the code: the entry points, the main call chain and \
         where control branches. Nodes are functions, modules or steps; edges are calls.",
    ),
    (
        2,
        "Architecture",
        "Show the components of the system and how they depend on each other: modules, layers, \
         services and the boundaries between them.",
    ),
    (
        3,
        "Data flow",
        "Follow the data: where it enters, how it is transformed, where it is stored and where \
         it leaves. Nodes are data sources, transformations and sinks.",
    ),
    (
        4,
        "API request cycle",
        "Show the life of an API request: entry point, routing, validation, business logic, \
         persistence and the response, including error paths.",
    ),
];

impl Engine {
    /// Built-in presets exist from the first launch; edits to them are never overwritten.
    pub fn ensure_builtin_presets(&self) -> Result<()> {
        let now = self.now();
        for (number, name, prompt) in BUILTIN_PRESETS {
            let id = FlowPresetId(Uuid::from_u128(*number));
            if self.db.get_flow_preset(id)?.is_none() {
                self.db.upsert_flow_preset(&FlowPreset {
                    id,
                    repository_id: None,
                    name: (*name).into(),
                    prompt: (*prompt).into(),
                    version: 1,
                    builtin: true,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                })?;
            }
        }
        Ok(())
    }

    pub fn flow_presets(&self, repository_id: RepositoryId) -> Result<Vec<FlowPreset>> {
        self.ensure_builtin_presets()?;
        self.db.list_flow_presets(repository_id)
    }

    /// Creates a preset, or edits one (which bumps its version). Never generates anything.
    pub fn save_flow_preset(
        &self,
        id: Option<FlowPresetId>,
        repository_id: Option<RepositoryId>,
        name: &str,
        prompt: &str,
    ) -> Result<FlowPreset> {
        let (name, prompt) = (name.trim(), prompt.trim());
        if name.is_empty() || prompt.is_empty() {
            return Err(Error::new(
                ErrorCode::Invalid,
                "a preset needs a name and a prompt",
            ));
        }
        if prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(Error::new(ErrorCode::Invalid, "the prompt is too long"));
        }
        let now = self.now();
        let preset = match id {
            Some(id) => {
                let mut existing = self
                    .db
                    .get_flow_preset(id)?
                    .ok_or_else(|| Error::new(ErrorCode::NotFound, "preset not found"))?;
                if existing.name != name || existing.prompt != prompt {
                    existing.version += 1;
                }
                existing.name = name.into();
                existing.prompt = prompt.into();
                existing.updated_at = now;
                existing
            }
            None => FlowPreset {
                id: FlowPresetId::new(),
                repository_id,
                name: name.into(),
                prompt: prompt.into(),
                version: 1,
                builtin: false,
                created_at: now.clone(),
                updated_at: now,
            },
        };
        self.db.upsert_flow_preset(&preset)?;
        Ok(preset)
    }

    pub fn delete_flow_preset(&self, id: FlowPresetId) -> Result<()> {
        let preset = self
            .db
            .get_flow_preset(id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "preset not found"))?;
        if preset.builtin {
            return Err(Error::new(
                ErrorCode::Invalid,
                "built-in presets cannot be deleted",
            ));
        }
        self.db.delete_flow_preset(id)
    }

    pub fn flows(&self, session_id: SessionId) -> Result<Vec<Artifact>> {
        self.db.list_artifacts(session_id, Some(ArtifactKind::Flow))
    }

    /// Starts one diagram generation. Only ever called from an explicit Generate.
    pub fn flow_generate(
        self: &Arc<Self>,
        session_id: SessionId,
        preset_id: FlowPresetId,
        extra: &str,
    ) -> Result<Artifact> {
        let extra = extra.trim();
        if extra.chars().count() > MAX_EXTRA_CHARS {
            return Err(Error::new(
                ErrorCode::Invalid,
                "the additional instructions are too long",
            ));
        }
        let session = self.session(session_id)?;
        if session.kind != SessionKind::Chat {
            return Err(Error::new(ErrorCode::Invalid, "diagrams belong to a chat"));
        }
        let preset = self
            .db
            .get_flow_preset(preset_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "preset not found"))?;
        // A diagram hangs off a checkpoint; take one now if the chat has none.
        let checkpoint = match self.db.latest_checkpoint(session_id)? {
            Some(checkpoint) => checkpoint,
            None => self.baseline_checkpoint(&session)?,
        };
        let version = self.flows(session_id)?.len() as u32 + 1;
        let now = self.now();
        let draft = Artifact {
            id: ArtifactId::new(),
            session_id,
            checkpoint_id: checkpoint.id,
            kind: ArtifactKind::Flow,
            // Each Generate is its own diagram; a retry reuses this one.
            dedupe_key: Uuid::new_v4().to_string(),
            version,
            status: ArtifactStatus::Queued,
            content: json!({}),
            provenance: json!({
                "generator": "agent-flow",
                "presetId": preset.id.0.to_string(),
                "presetName": preset.name,
                "presetVersion": preset.version,
                "prompt": preset.prompt,
                "extra": extra,
                "provider": session.provider.as_str(),
                "headRev": checkpoint.head_rev,
            }),
            error: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let (stored, _) = self.db.ensure_artifact(&draft)?;
        self.emit_artifact(&stored);
        let engine = Arc::clone(self);
        let id = stored.id;
        std::thread::spawn(move || engine.run_flow(id));
        Ok(stored)
    }

    pub(crate) fn rerun_flow(self: &Arc<Self>, artifact: Artifact) -> Result<Artifact> {
        let queued = self.set_artifact(artifact.id, ArtifactStatus::Queued, None, None, None)?;
        let engine = Arc::clone(self);
        let id = queued.id;
        std::thread::spawn(move || engine.run_flow(id));
        Ok(queued)
    }

    /// A manual checkpoint with no changes: the anchor for artifacts of a chat that has not
    /// produced any yet.
    pub(crate) fn baseline_checkpoint(
        &self,
        session: &crate::domain::ChatSession,
    ) -> Result<crate::domain::Checkpoint> {
        let target = self.target_of(session, None)?;
        let root = target.path.clone();
        let head = self.git.snapshot(
            &root,
            &format!("manual/{}/{}", session.id.0, Uuid::new_v4().simple()),
        )?;
        let base = self.git.head_rev(&root).unwrap_or_else(|_| head.clone());
        let checkpoint =
            self.create_checkpoint(session, &target, base, head, CheckpointSource::Manual, None)?;
        let _ = self
            .db
            .update_checkpoint_status(checkpoint.id, ArtifactStatus::Ready);
        Ok(checkpoint)
    }

    fn run_flow(self: &Arc<Self>, id: ArtifactId) {
        let outcome = self.flow_task(id);
        let _ = match outcome {
            Ok(content) => self.set_artifact(id, ArtifactStatus::Ready, Some(&content), None, None),
            Err(error) => {
                self.set_artifact(id, ArtifactStatus::Failed, None, None, Some(&error.message))
            }
        };
    }

    fn flow_task(self: &Arc<Self>, id: ArtifactId) -> Result<serde_json::Value> {
        let artifact = self.set_artifact(id, ArtifactStatus::Running, None, None, None)?;
        let session = self.session(artifact.session_id)?;
        let root = self.worktree_path(&session)?;
        let text = |key: &str| {
            artifact
                .provenance
                .get(key)
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string()
        };
        let files = self.git.list_files(&root)?;
        let known: HashSet<String> =
            super::workspace::known_files(self.db.as_ref(), self.git.as_ref(), &session)?;
        let structure = structure_summary(&files, &|path| {
            self.fs
                .read_text(&root, path)
                .ok()
                .filter(|file| !file.binary && !file.too_large)
                .map(|file| file.text)
        });
        let others: Vec<String> = super::workspace::session_roots(self.db.as_ref(), &session)?
            .into_iter()
            .skip(1)
            .map(|(name, path)| format!("{name} ({})", path.display()))
            .collect();
        let structure = if others.is_empty() {
            structure
        } else {
            format!(
                "{structure}\n\nThis workspace has more repositories: {}. Name a file of any of them as <repository>/<path>.",
                others.join(", ")
            )
        };
        let prompt = flow_prompt(&text("prompt"), &text("extra"), &structure);
        let hidden = self.hidden_session(&session, SessionKind::Analysis, "Flow generation")?;
        let answer = self.ask_and_wait(&hidden, &prompt)?;
        let graph = parse_flow(&answer, &known)?;
        let mut content = serde_json::to_value(&graph)
            .map_err(|error| Error::new(ErrorCode::Invalid, error.to_string()))?;
        content["generatedAt"] = json!(self.now());
        Ok(content)
    }
}

impl crate::api::Anchor for Engine {
    fn baseline(
        &self,
        session: crate::domain::ids::SessionId,
    ) -> Result<crate::domain::Checkpoint> {
        let session = self.session(session)?;
        self.baseline_checkpoint(&session)
    }
}
