import { invoke } from "@tauri-apps/api/core";
import type { ProviderKind, SessionId, SessionStatus, WorkspaceId } from "./workspace";

/** What an entry on the board is. */
export type EntryKind = "decision" | "claim" | "question" | "done" | "note" | "directive";

/**
 * Where an entry stands. A `contested` decision is a proposal against the one that stands: it binds
 * nobody until the developer settles it.
 */
export type EntryState = "active" | "superseded" | "contested" | "released" | "answered" | "dismissed";

/** A place in the code an entry is about. */
export type Anchor = { path: string; rev: string | null; startLine: number | null; endLine: number | null };

export type WorkbenchEntry = {
  id: string;
  seq: number;
  workspaceId: WorkspaceId;
  /** `null` is the developer. */
  author: SessionId | null;
  authorLabel: string;
  kind: EntryKind;
  state: EntryState;
  /** What it is about, as a short key: `type:UserDTO`, `route:/users`. */
  topic: string | null;
  text: string;
  why: string | null;
  paths: string[];
  anchor: Anchor | null;
  /** `developer`, or the id of the agent it is for; `null` is everyone. */
  to: string | null;
  replyTo: string | null;
  /** When a claim lapses. */
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EntryView = WorkbenchEntry & {
  shortId: string;
  /** Still in force: active, and for a claim not lapsed. */
  live: boolean;
  toLabel: string | null;
};

/** A chat on the board. */
export type MemberView = {
  sessionId: SessionId;
  title: string;
  provider: ProviderKind;
  status: SessionStatus;
  branch: string | null;
  joinedAt: string;
  /** What it said it is doing: its newest live claim. */
  now: string | null;
  /** What its live claims hold: paths and topics. */
  holds: string[];
  filesChanged: number;
  additions: number;
  deletions: number;
  /** Posts by others its agent has not been handed yet. */
  unseen: number;
  lastPostAt: string | null;
  /** Its newest post is a `done`. */
  finished: boolean;
  problem: string | null;
};

/** What stands on a topic, what is proposed against it, what holds it and what is asked. */
export type TopicView = {
  topic: string;
  standing: EntryView | null;
  proposals: EntryView[];
  heldBy: EntryView[];
  openQuestions: EntryView[];
  history: number;
  updatedAt: string;
};

export type FileChange = "added" | "modified" | "deleted" | "renamed";

/** `shared`: several agents on a file, in other parts of it. `collision`: the same lines. */
export type Severity = "clear" | "shared" | "collision";

export type Toucher = {
  sessionId: SessionId;
  change: FileChange;
  additions: number;
  deletions: number;
  /** Lines of the file as it was, both ends included. Read only when the file is shared. */
  ranges: [number, number][];
  /** Its changes are on top of another agent's, or git cannot merge them. */
  clash: boolean;
};

export type FileRow = {
  repositoryId: string;
  repository: string;
  path: string;
  /** A lockfile or the like: regenerate it when the work is joined, do not merge it by hand. */
  generated: boolean;
  severity: Severity;
  /** One agent deleted it, or it is binary: git cannot merge what several did to it. */
  destructive: boolean;
  touchers: Toucher[];
  /** The agent that holds a live claim over the path. */
  heldBy: SessionId | null;
};

export type NeedKind = "question" | "disagreement" | "collision" | "approval";

export type NeedView = {
  kind: NeedKind;
  entryId: string | null;
  sessionIds: SessionId[];
  title: string;
  detail: string;
  path: string | null;
};

export type WorkbenchView = {
  workspaceId: WorkspaceId;
  members: MemberView[];
  /** Newest first. */
  entries: EntryView[];
  topics: TopicView[];
  files: FileRow[];
  needsYou: NeedView[];
  latestSeq: number;
};

/** What the developer does to an entry. */
export type Resolution = "adopt" | "dismiss" | "release";

export const workbenchView = (workspaceId: WorkspaceId) => invoke<WorkbenchView>("workbench_view", { workspaceId });
export const workbenchJoin = (sessionId: SessionId) => invoke<void>("workbench_join", { sessionId });
export const workbenchLeave = (sessionId: SessionId) => invoke<void>("workbench_leave", { sessionId });
export const workbenchClear = (workspaceId: WorkspaceId) => invoke<void>("workbench_clear", { workspaceId });

/** The developer says something to every agent on the board, or to one. With a topic it becomes the decision there. */
export const workbenchDirect = (workspaceId: WorkspaceId, text: string, to: SessionId | null = null, topic: string | null = null) =>
  invoke<WorkbenchEntry>("workbench_direct", { workspaceId, text, to, topic });

/** Answers an entry; the answer goes to its author. */
export const workbenchReply = (entryId: string, text: string) => invoke<WorkbenchEntry>("workbench_reply", { entryId, text });

export const workbenchResolve = (entryId: string, resolution: Resolution) =>
  invoke<void>("workbench_resolve", { entryId, resolution });
