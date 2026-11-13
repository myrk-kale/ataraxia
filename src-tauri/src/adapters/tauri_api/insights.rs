//! Commands for Code, Decisions, BTW, Flow, artifacts and settings.

use super::{AppState, map_error};
use crate::app::artifacts::{ReviewView, Side};
use crate::app::btw::BtwContext;
use crate::app::decisions::DecisionDetail;
use crate::domain::ids::{CheckpointId, RepositoryId, SessionId, TurnId, WorktreeId};
use crate::domain::{
    Artifact, ArtifactId, BtwMode, BtwTask, BtwTaskId, ChatSession, Checkpoint, CodeRef, Decision,
    DecisionId, DecisionKind, DecisionMessage, DecisionState, FlowPreset, FlowPresetId,
    ReturnPolicy, ReviewComment, ReviewMark, ReviewState,
};
use crate::ports::FileContent;

type Res<T> = std::result::Result<T, String>;

#[tauri::command(async)]
pub fn session_get(state: tauri::State<'_, AppState>, session_id: SessionId) -> Res<ChatSession> {
    state
        .store
        .get_session(session_id)
        .map_err(map_error)?
        .ok_or_else(|| "error[not-found]: session not found".to_string())
}

// ------------------------------------------------------------------ code

#[tauri::command(async)]
pub fn code_tree(state: tauri::State<'_, AppState>, worktree_id: WorktreeId) -> Res<Vec<String>> {
    state.engine.code_tree(worktree_id).map_err(map_error)
}

#[tauri::command(async)]
pub fn code_read(
    state: tauri::State<'_, AppState>,
    worktree_id: WorktreeId,
    path: String,
) -> Res<FileContent> {
    state
        .engine
        .code_read(worktree_id, &path)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn code_write(
    state: tauri::State<'_, AppState>,
    worktree_id: WorktreeId,
    path: String,
    text: String,
    expected_mtime_ms: Option<i64>,
) -> Res<i64> {
    state
        .engine
        .code_write(worktree_id, &path, &text, expected_mtime_ms)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn code_file_at(
    state: tauri::State<'_, AppState>,
    checkpoint_id: CheckpointId,
    path: String,
    side: Side,
) -> Res<Option<String>> {
    state
        .engine
        .code_file_at(checkpoint_id, &path, side)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn code_review(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    checkpoint_id: Option<CheckpointId>,
    repository_id: Option<RepositoryId>,
) -> Res<ReviewView> {
    state
        .engine
        .review_in(session_id, checkpoint_id, repository_id)
        .map_err(map_error)
}

/// For each repository of the chat's workspace, what the agent changed there and what is unseen.
#[tauri::command(async)]
pub fn code_repo_changes(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
) -> Res<Vec<crate::app::artifacts::RepoChanges>> {
    state.engine.repo_changes(session_id).map_err(map_error)
}

#[tauri::command(async)]
pub fn code_refresh_checkpoint(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    repository_id: Option<RepositoryId>,
) -> Res<Option<Checkpoint>> {
    state
        .engine
        .refresh_checkpoint_in(session_id, repository_id)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn code_set_review_mark(
    state: tauri::State<'_, AppState>,
    checkpoint_id: CheckpointId,
    path: String,
    review_state: ReviewState,
) -> Res<ReviewMark> {
    state
        .engine
        .set_review_mark(checkpoint_id, &path, review_state)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn code_add_comment(
    state: tauri::State<'_, AppState>,
    checkpoint_id: CheckpointId,
    path: String,
    line: Option<u32>,
    side: Side,
    text: String,
) -> Res<ReviewComment> {
    state
        .engine
        .add_review_comment(checkpoint_id, &path, line, side, &text)
        .map_err(map_error)
}

// ------------------------------------------------------------------ artifacts

#[tauri::command(async)]
pub fn artifacts_list(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
) -> Res<Vec<Artifact>> {
    state.engine.artifacts(session_id).map_err(map_error)
}

#[tauri::command(async)]
pub fn artifact_retry(state: tauri::State<'_, AppState>, artifact_id: ArtifactId) -> Res<Artifact> {
    state.engine.retry_artifact(artifact_id).map_err(map_error)
}

#[tauri::command(async)]
pub fn checkpoints_list(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
) -> Res<Vec<Checkpoint>> {
    state.db_checkpoints(session_id).map_err(map_error)
}

/// Generates decisions on the provider and model the reviewer picked. Only ever on request.
#[tauri::command(async)]
pub fn decisions_generate(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    checkpoint_id: Option<CheckpointId>,
    provider: Option<crate::domain::agent::ProviderKind>,
    model: Option<String>,
) -> Res<Artifact> {
    state
        .engine
        .generate_decisions(session_id, checkpoint_id, provider, model)
        .map_err(map_error)
}

// ------------------------------------------------------------------ decisions

#[tauri::command(async)]
pub fn decisions_list(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
) -> Res<Vec<Decision>> {
    state.engine.decisions(session_id).map_err(map_error)
}

#[tauri::command(async)]
pub fn decision_detail(
    state: tauri::State<'_, AppState>,
    decision_id: DecisionId,
) -> Res<DecisionDetail> {
    state.engine.decision_detail(decision_id).map_err(map_error)
}

#[tauri::command(async)]
pub fn decision_create(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    title: String,
    summary: String,
    kind: DecisionKind,
) -> Res<Decision> {
    state
        .engine
        .create_decision(session_id, &title, &summary, kind, Vec::new(), "you")
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn decision_link_commit(
    state: tauri::State<'_, AppState>,
    decision_id: DecisionId,
    rev: String,
    note: String,
) -> Res<crate::domain::DecisionCommit> {
    state
        .engine
        .link_decision_commit(decision_id, &rev, &note, "user")
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn decision_unlink_commit(
    state: tauri::State<'_, AppState>,
    decision_id: DecisionId,
    rev: String,
) -> Res<()> {
    state
        .engine
        .unlink_decision_commit(decision_id, &rev)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn decision_commit_candidates(
    state: tauri::State<'_, AppState>,
    decision_id: DecisionId,
) -> Res<Vec<crate::app::decisions::CommitCandidate>> {
    state
        .engine
        .decision_commit_candidates(decision_id)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn decision_set_state(
    state: tauri::State<'_, AppState>,
    decision_id: DecisionId,
    decision_state: DecisionState,
    comment: Option<String>,
) -> Res<Decision> {
    state
        .engine
        .set_decision_state_with_comment(decision_id, decision_state, comment.as_deref())
        .map_err(map_error)
}

/// A comment in the thread that nothing answers.
#[tauri::command(async)]
pub fn decision_comment(
    state: tauri::State<'_, AppState>,
    decision_id: DecisionId,
    text: String,
) -> Res<DecisionMessage> {
    state
        .engine
        .comment_decision(decision_id, &text)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn decision_post_message(
    state: tauri::State<'_, AppState>,
    decision_id: DecisionId,
    text: String,
    code_ref: Option<CodeRef>,
) -> Res<DecisionMessage> {
    state
        .engine
        .post_decision_message(decision_id, &text, code_ref)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn decision_request_change(
    state: tauri::State<'_, AppState>,
    decision_id: DecisionId,
    text: String,
) -> Res<TurnId> {
    state
        .engine
        .request_decision_change(decision_id, &text)
        .map_err(map_error)
}

// ------------------------------------------------------------------ BTW

#[tauri::command(async)]
pub fn btw_preview_context(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    context: BtwContext,
) -> Res<String> {
    state
        .engine
        .btw_render_context(session_id, &context)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn btw_start(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    mode: BtwMode,
    question: String,
    context: BtwContext,
    return_policy: ReturnPolicy,
    authorized: bool,
    provider: Option<crate::domain::agent::ProviderKind>,
    model: Option<String>,
) -> Res<BtwTask> {
    state
        .engine
        .btw_start_with(
            session_id,
            mode,
            &question,
            &context,
            return_policy,
            authorized,
            provider,
            model,
        )
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn btw_list(state: tauri::State<'_, AppState>, session_id: SessionId) -> Res<Vec<BtwTask>> {
    state.engine.btw_tasks(session_id).map_err(map_error)
}

#[tauri::command(async)]
pub fn btw_return(state: tauri::State<'_, AppState>, task_id: BtwTaskId) -> Res<()> {
    state.engine.btw_return(task_id).map_err(map_error)
}

#[tauri::command(async)]
pub fn btw_session(state: tauri::State<'_, AppState>, task_id: BtwTaskId) -> Res<ChatSession> {
    state.engine.btw_session(task_id).map_err(map_error)
}

// ------------------------------------------------------------------ flow

#[tauri::command(async)]
pub fn flow_presets(
    state: tauri::State<'_, AppState>,
    repository_id: RepositoryId,
) -> Res<Vec<FlowPreset>> {
    state.engine.flow_presets(repository_id).map_err(map_error)
}

#[tauri::command(async)]
pub fn flow_save_preset(
    state: tauri::State<'_, AppState>,
    preset_id: Option<FlowPresetId>,
    repository_id: Option<RepositoryId>,
    name: String,
    prompt: String,
) -> Res<FlowPreset> {
    state
        .engine
        .save_flow_preset(preset_id, repository_id, &name, &prompt)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn flow_delete_preset(state: tauri::State<'_, AppState>, preset_id: FlowPresetId) -> Res<()> {
    state
        .engine
        .delete_flow_preset(preset_id)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn flow_generate(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    preset_id: FlowPresetId,
    extra: String,
) -> Res<Artifact> {
    state
        .engine
        .flow_generate(session_id, preset_id, &extra)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn flow_list(state: tauri::State<'_, AppState>, session_id: SessionId) -> Res<Vec<Artifact>> {
    state.engine.flows(session_id).map_err(map_error)
}

// ------------------------------------------------------------------ diff target

#[tauri::command(async)]
pub fn code_refs(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    repository_id: Option<RepositoryId>,
) -> Res<crate::domain::GitRefs> {
    state
        .engine
        .code_refs_in(session_id, repository_id)
        .map_err(map_error)
}

/// Diffs two revisions. `head: None` means the working tree as it is now.
#[tauri::command(async)]
pub fn code_compare(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    base: String,
    head: Option<String>,
    merge_base: bool,
    repository_id: Option<RepositoryId>,
) -> Res<Checkpoint> {
    state
        .engine
        .compare_in(
            session_id,
            &base,
            head.as_deref(),
            merge_base,
            repository_id,
        )
        .map_err(map_error)
}

/// Takes a priority that was set on a unit away; it goes back to what the code says.
#[tauri::command(async)]
pub fn review_reset_priority(
    state: tauri::State<'_, AppState>,
    checkpoint_id: CheckpointId,
    path: String,
    name: String,
) -> Res<()> {
    state
        .engine
        .reset_unit_priority(checkpoint_id, &path, &name)
        .map_err(map_error)
}

/// Deletes everything derived for a chat. The chat's title has to be sent back as confirmation.
#[tauri::command(async)]
pub fn artifacts_delete_all(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    confirm: String,
) -> Res<crate::app::artifacts::ClearedArtifacts> {
    state
        .engine
        .delete_artifacts(session_id, &confirm)
        .map_err(map_error)
}
