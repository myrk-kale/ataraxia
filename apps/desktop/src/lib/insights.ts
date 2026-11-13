import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProviderKind } from "./workspace";
import type { RepositoryId, SessionId, WorktreeId, ChatSession } from "./workspace";

export type CheckpointId = string;
export type ArtifactId = string;
export type DecisionId = string;
export type BtwTaskId = string;
export type FlowPresetId = string;

export type ArtifactStatus = "queued" | "running" | "ready" | "failed" | "stale";
export type ArtifactKind = "decision" | "review_priority" | "flow";
export type FileChange = "added" | "modified" | "deleted" | "renamed";

export type ChangedFile = {
  path: string;
  old_path: string | null;
  change: FileChange;
  additions: number;
  deletions: number;
  binary: boolean;
};

export type Checkpoint = {
  id: CheckpointId;
  session_id: SessionId;
  repository_id: RepositoryId;
  worktree_id: WorktreeId;
  seq: number;
  base_rev: string;
  head_rev: string;
  source: "turn" | "manual" | "compare";
  turn_id: string | null;
  files: ChangedFile[];
  status: ArtifactStatus;
  created_at: string;
  /** What each side is called (`main`, `a1b2c3d`, `working tree`); null for a turn. */
  base_label?: string | null;
  head_label?: string | null;
  /** The head is the live working tree, so files can be edited. */
  head_live?: boolean;
};

export type Artifact = {
  id: ArtifactId;
  session_id: SessionId;
  checkpoint_id: CheckpointId;
  kind: ArtifactKind;
  dedupe_key: string;
  version: number;
  status: ArtifactStatus;
  content: Record<string, unknown>;
  provenance: Record<string, unknown>;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type Level = "high" | "medium" | "low";

export type FileScore = {
  path: string;
  score: number;
  level: Level;
  reasons: string[];
  additions: number;
  deletions: number;
  change: FileChange;
};

export type UnitChange = "added" | "modified" | "removed";

/** A function, method, type or file a change is attributed to. */
export type Unit = {
  id: string;
  name: string;
  kind: string;
  path: string;
  start_line: number;
  end_line: number;
  side: "head" | "base";
  change: UnitChange;
  signature_changed: boolean;
  public: boolean;
  references: number;
  additions: number;
  deletions: number;
  score: number;
  level: Level;
  reasons: string[];
  container: string | null;
  /** Every point of the score and why it was given. */
  factors?: ScoreFactor[];
  complexity?: number;
  format_only?: boolean;
  markers?: { rule: string; title: string; line: number; introduced: boolean }[];
  /** How the outside reaches it: a route, command or main (`external`), or just an export. */
  entry?: "external" | "internal" | null;
  sensitive?: string | null;
  tested?: boolean | null;
  dirs?: number;
  generated?: boolean;
};

export type ScoreFactor = {
  component: "contract" | "reach" | "sensitivity" | "complexity" | "risk" | "tests" | "size" | "mitigation" | "adjustment";
  points: number;
  reason: string;
};

export type ComponentScore = {
  id: string;
  name: string;
  path?: string | null;
  units?: string[];
  files: string[];
  score: number;
  level: Level;
  additions: number;
  deletions: number;
  reasons: string[];
};

export type ReviewPriority = {
  components: ComponentScore[];
  files: FileScore[];
  units?: Unit[];
  languages?: string[];
};

export type RefInfo = { name: string; kind: "branch" | "remote" | "tag"; rev: string; subject: string };
export type CommitInfo = { rev: string; short: string; subject: string; date: string; author: string };
export type GitRefs = { current: string | null; refs: RefInfo[]; commits: CommitInfo[] };

export type ReviewState = "unreviewed" | "viewed" | "approved" | "changes-requested";

export type ReviewMark = {
  checkpoint_id: CheckpointId;
  path: string;
  state: ReviewState;
  updated_at: string;
};

export type ReviewComment = {
  id: string;
  checkpoint_id: CheckpointId;
  path: string;
  line: number | null;
  side: "base" | "head";
  text: string;
  /** `you`, or `agent` when it was asked for in the chat or in BTW. */
  author?: "you" | "agent";
  created_at: string;
};

export type ReviewView = {
  checkpoints: Checkpoint[];
  checkpoint: Checkpoint | null;
  priority: ReviewPriority | null;
  marks: ReviewMark[];
  comments: ReviewComment[];
  artifacts: Artifact[];
};

export type FileContent = {
  path: string;
  text: string;
  binary: boolean;
  tooLarge: boolean;
  size: number;
  mtimeMs: number;
};

export type DecisionKind =
  | "api-contract"
  | "data-integrity"
  | "behavior"
  | "security"
  | "dependencies"
  | "performance"
  | "code-organization"
  | "ux"
  | "other";

export type DecisionState = "pending" | "approved" | "rejected" | "superseded";

export type CodeRef = { path: string; start_line: number | null; end_line: number | null };

export type Decision = {
  id: DecisionId;
  session_id: SessionId;
  checkpoint_id: CheckpointId;
  artifact_id: ArtifactId | null;
  seq: number;
  kind: DecisionKind;
  title: string;
  summary: string;
  context: string;
  rationale: string;
  alternatives: { title: string; note: string }[];
  refs: CodeRef[];
  state: DecisionState;
  version: number;
  superseded_by: DecisionId | null;
  /** `you`, `agent`, or the provider and model that generated it. */
  opened_by: string;
  created_at: string;
  updated_at: string;
};

export type DecisionCommit = {
  decision_id: DecisionId;
  rev: string;
  short: string;
  subject: string;
  author: string;
  committed_at: string;
  note: string;
  linked_by: "user" | "agent";
  created_at: string;
};

export type CommitCandidate = {
  commit: CommitInfo;
  touchesDecisionFiles: boolean;
  linked: boolean;
};

export type DecisionMessage = {
  id: string;
  decision_id: DecisionId;
  author: "user" | "agent" | "system";
  text: string;
  code_ref: CodeRef | null;
  created_at: string;
};

export type DecisionDetail = {
  decision: Decision;
  messages: DecisionMessage[];
  revisions: { decision_id: DecisionId; version: number; reason: string; created_at: string }[];
  commits: DecisionCommit[];
  laterChanges: { checkpointId: CheckpointId; seq: number; paths: string[] }[];
  checkpointSeq: number;
};

export type BtwMode = "ask" | "change";
export type ReturnPolicy = "manual" | "on-completion";

export type BtwContextItem = {
  kind: string;
  label: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  text?: string;
};

/** What BTW is told: the space it was summoned from and its open item, plus what the other spaces have open. */
export type BtwContext = { space: string; item?: BtwContextItem | null; active?: BtwContextItem[] };

export type BtwTask = {
  id: BtwTaskId;
  parent_session_id: SessionId;
  session_id: SessionId;
  mode: BtwMode;
  question: string;
  context_text: string;
  return_policy: ReturnPolicy;
  summary: string | null;
  returned_at: string | null;
  status: ArtifactStatus;
  created_at: string;
  updated_at: string;
};

export type FlowPreset = {
  id: FlowPresetId;
  repository_id: RepositoryId | null;
  name: string;
  prompt: string;
  version: number;
  builtin: boolean;
  created_at: string;
  updated_at: string;
};

export type FlowRef = { path: string; start_line: number | null; end_line: number | null };
export type FlowNodeData = {
  id: string;
  label: string;
  kind: string;
  description: string;
  refs: FlowRef[];
  verified: boolean;
};
export type FlowEdgeData = { id: string; source: string; target: string; label: string };
export type FlowContent = {
  summary?: string;
  nodes?: FlowNodeData[];
  edges?: FlowEdgeData[];
  generatedAt?: string;
};

export type InsightEvent =
  | { type: "checkpoint"; sessionId: SessionId; checkpointId: CheckpointId }
  | {
      type: "artifact";
      sessionId: SessionId;
      artifactId: ArtifactId;
      kind: ArtifactKind;
      status: ArtifactStatus;
    }
  | { type: "decisions"; sessionId: SessionId }
  | { type: "cleared"; sessionId: SessionId }
  | { type: "decisionThread"; decisionId: DecisionId }
  | { type: "btw"; taskId: BtwTaskId; parentSessionId: SessionId; status: ArtifactStatus };

export type McpInfo = { command: string; args: string[]; configJson: string };

export function listenInsightEvents(handler: (event: InsightEvent) => void): Promise<UnlistenFn> {
  return listen<InsightEvent>("insight://event", (event) => handler(event.payload));
}

// code
export const codeTree = (worktreeId: WorktreeId) => invoke<string[]>("code_tree", { worktreeId });
export const codeRead = (worktreeId: WorktreeId, path: string) =>
  invoke<FileContent>("code_read", { worktreeId, path });
export const codeWrite = (
  worktreeId: WorktreeId,
  path: string,
  text: string,
  expectedMtimeMs: number | null,
) => invoke<number>("code_write", { worktreeId, path, text, expectedMtimeMs });
export const codeFileAt = (checkpointId: CheckpointId, path: string, side: "base" | "head") =>
  invoke<string | null>("code_file_at", { checkpointId, path, side });
export const codeReview = (sessionId: SessionId, checkpointId: CheckpointId | null) =>
  invoke<ReviewView>("code_review", { sessionId, checkpointId });
export const codeRefreshCheckpoint = (sessionId: SessionId) =>
  invoke<Checkpoint | null>("code_refresh_checkpoint", { sessionId });
export const codeSetReviewMark = (checkpointId: CheckpointId, path: string, reviewState: ReviewState) =>
  invoke<ReviewMark>("code_set_review_mark", { checkpointId, path, reviewState });
export const codeAddComment = (
  checkpointId: CheckpointId,
  path: string,
  line: number | null,
  side: "base" | "head",
  text: string,
) => invoke<ReviewComment>("code_add_comment", { checkpointId, path, line, side, text });

// artifacts
export const artifactsList = (sessionId: SessionId) => invoke<Artifact[]>("artifacts_list", { sessionId });
export const artifactRetry = (artifactId: ArtifactId) => invoke<Artifact>("artifact_retry", { artifactId });
/** Generates decisions on the provider and model given (the chat's own when null). Only on request. */
export const decisionsGenerate = (
  sessionId: SessionId,
  checkpointId: CheckpointId | null,
  provider: ProviderKind | null,
  model: string | null,
) => invoke<Artifact>("decisions_generate", { sessionId, checkpointId, provider, model });
export const checkpointsList = (sessionId: SessionId) =>
  invoke<Checkpoint[]>("checkpoints_list", { sessionId });

// decisions
export const decisionsList = (sessionId: SessionId) => invoke<Decision[]>("decisions_list", { sessionId });
export const decisionDetail = (decisionId: DecisionId) =>
  invoke<DecisionDetail>("decision_detail", { decisionId });
export const decisionCreate = (sessionId: SessionId, title: string, summary: string, kind: DecisionKind) =>
  invoke<Decision>("decision_create", { sessionId, title, summary, kind });
export const decisionLinkCommit = (decisionId: DecisionId, rev: string, note: string) =>
  invoke<DecisionCommit>("decision_link_commit", { decisionId, rev, note });
export const decisionUnlinkCommit = (decisionId: DecisionId, rev: string) =>
  invoke<void>("decision_unlink_commit", { decisionId, rev });
export const decisionCommitCandidates = (decisionId: DecisionId) =>
  invoke<CommitCandidate[]>("decision_commit_candidates", { decisionId });
/** A verdict, with the comment written beside it if there is one. */
export const decisionSetState = (decisionId: DecisionId, decisionState: DecisionState, comment: string | null = null) =>
  invoke<Decision>("decision_set_state", { decisionId, decisionState, comment });
/** A comment in the thread that nothing answers. */
export const decisionComment = (decisionId: DecisionId, text: string) =>
  invoke<DecisionMessage>("decision_comment", { decisionId, text });
export const decisionPostMessage = (decisionId: DecisionId, text: string, codeRef: CodeRef | null) =>
  invoke<DecisionMessage>("decision_post_message", { decisionId, text, codeRef });
export const decisionRequestChange = (decisionId: DecisionId, text: string) =>
  invoke<string>("decision_request_change", { decisionId, text });

// btw
export const btwPreviewContext = (sessionId: SessionId, context: BtwContext) =>
  invoke<string>("btw_preview_context", { sessionId, context });
export const btwStart = (
  sessionId: SessionId,
  mode: BtwMode,
  question: string,
  context: BtwContext,
  returnPolicy: ReturnPolicy,
  authorized: boolean,
  provider: ProviderKind | null = null,
  model: string | null = null,
) =>
  invoke<BtwTask>("btw_start", { sessionId, mode, question, context, returnPolicy, authorized, provider, model });
export const btwList = (sessionId: SessionId) => invoke<BtwTask[]>("btw_list", { sessionId });
export const btwReturn = (taskId: BtwTaskId) => invoke<void>("btw_return", { taskId });
export const btwSession = (taskId: BtwTaskId) => invoke<ChatSession>("btw_session", { taskId });
export const sessionGet = (sessionId: SessionId) => invoke<ChatSession>("session_get", { sessionId });

// flow
export const flowPresets = (repositoryId: RepositoryId) =>
  invoke<FlowPreset[]>("flow_presets", { repositoryId });
export const flowSavePreset = (
  presetId: FlowPresetId | null,
  repositoryId: RepositoryId | null,
  name: string,
  prompt: string,
) => invoke<FlowPreset>("flow_save_preset", { presetId, repositoryId, name, prompt });
export const flowDeletePreset = (presetId: FlowPresetId) =>
  invoke<void>("flow_delete_preset", { presetId });
export const flowGenerate = (sessionId: SessionId, presetId: FlowPresetId, extra: string) =>
  invoke<Artifact>("flow_generate", { sessionId, presetId, extra });
export const flowList = (sessionId: SessionId) => invoke<Artifact[]>("flow_list", { sessionId });

// settings
export const settingsMcpInfo = () => invoke<McpInfo>("settings_mcp_info");

// diff target
export const codeRefs = (sessionId: SessionId) => invoke<GitRefs>("code_refs", { sessionId });
/** Diffs two revisions; `head: null` is the working tree as it is now. */
export const codeCompare = (sessionId: SessionId, base: string, head: string | null, mergeBase: boolean) =>
  invoke<Checkpoint>("code_compare", { sessionId, base, head, mergeBase });

/** Takes a priority that was set on a unit away: it goes back to what the code says. */
export const reviewResetPriority = (checkpointId: CheckpointId, path: string, name: string) =>
  invoke<void>("review_reset_priority", { checkpointId, path, name });

/** Deletes everything derived for a chat (checkpoints, queues, decisions, diagrams, marks, comments). */
export const artifactsDeleteAll = (sessionId: SessionId, confirm: string) =>
  invoke<{ checkpoints: number; decisions: number; diagrams: number }>("artifacts_delete_all", { sessionId, confirm });
