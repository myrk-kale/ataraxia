import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceId } from "./workspace";

/** What sort of knowledge a memory holds. */
export type MemoryKind = "semantic" | "episodic" | "procedural" | "working";

/** Who stood behind it: the developer said it, the agent verified it, or the agent concluded it. */
export type MemorySource = "user" | "observed" | "inferred";

export type Relation =
  | "relates_to"
  | "part_of"
  | "depends_on"
  | "caused_by"
  | "supports"
  | "contradicts"
  | "supersedes"
  | "example_of";

export type Memory = {
  id: string;
  kind: MemoryKind;
  /** `null` is global: the developer's own, seen from every workspace. */
  workspaceId: WorkspaceId | null;
  title: string;
  body: string;
  tags: string[];
  source: MemorySource;
  author: "agent" | "developer";
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Read as "from <relation> to". */
export type MemoryLink = { fromId: string; toId: string; relation: Relation; createdAt: string };

export type MemorySnapshot = { enabled: boolean; memories: Memory[]; links: MemoryLink[] };

export type MemoryInput = {
  kind: MemoryKind;
  workspaceId: WorkspaceId | null;
  title: string;
  body: string;
  tags: string[];
  expiresAt?: string | null;
};

/** Only what is named changes; `workspaceId: null` moves it to the global memory. */
export type MemoryChange = Partial<Pick<Memory, "kind" | "workspaceId" | "title" | "body" | "tags" | "source" | "expiresAt">>;

export const memorySnapshot = () => invoke<MemorySnapshot>("memory_snapshot");
export const memorySetEnabled = (enabled: boolean) => invoke<void>("memory_set_enabled", { enabled });
export const memoryCreate = (input: MemoryInput) => invoke<Memory>("memory_create", { input });
export const memoryUpdate = (id: string, change: MemoryChange) => invoke<Memory>("memory_update", { id, change });
export const memoryDelete = (id: string) => invoke<void>("memory_delete", { id });
export const memoryLink = (from: string, to: string, relation: Relation) =>
  invoke<MemoryLink>("memory_link", { from, to, relation });
export const memoryUnlink = (from: string, to: string, relation: Relation) =>
  invoke<void>("memory_unlink", { from, to, relation });

export const KIND_ORDER: readonly MemoryKind[] = ["semantic", "episodic", "procedural", "working"];

export const KIND_LABEL: Record<MemoryKind, string> = {
  semantic: "Semantic",
  episodic: "Episodic",
  procedural: "Procedural",
  working: "Working",
};

export const KIND_HINT: Record<MemoryKind, string> = {
  semantic: "A fact, a preference or a decision with its reason",
  episodic: "Something that happened: the error, its cause, the fix",
  procedural: "How to do something, or how you want it done",
  working: "The state of work in progress. It expires",
};

export const SOURCE_LABEL: Record<MemorySource, string> = {
  user: "You said it",
  observed: "Verified by the agent",
  inferred: "Inferred by the agent",
};

export const RELATION_ORDER: readonly Relation[] = [
  "relates_to",
  "part_of",
  "depends_on",
  "caused_by",
  "supports",
  "contradicts",
  "supersedes",
  "example_of",
];

/** Spoken as "<this> <label> <that>". */
export const RELATION_LABEL: Record<Relation, string> = {
  relates_to: "relates to",
  part_of: "is part of",
  depends_on: "depends on",
  caused_by: "was caused by",
  supports: "supports",
  contradicts: "contradicts",
  supersedes: "supersedes",
  example_of: "is an example of",
};

/** The same relation read from the other end: "<that> <label> <this>". */
export const RELATION_INVERSE_LABEL: Record<Relation, string> = {
  relates_to: "relates to",
  part_of: "has part",
  depends_on: "is needed by",
  caused_by: "caused",
  supports: "is supported by",
  contradicts: "contradicts",
  supersedes: "is superseded by",
  example_of: "has example",
};

/** `relates_to` and `contradicts` mean the same from either end, so they draw without an arrow. */
export const isSymmetric = (relation: Relation) => relation === "relates_to" || relation === "contradicts";

export function isExpired(memory: Memory, now = Date.now()): boolean {
  return memory.expiresAt !== null && Date.parse(memory.expiresAt) <= now;
}

/** Tags are typed as `a, b c`; they are stored lowercase, one word each. */
export function parseTags(text: string): string[] {
  const tags = text
    .split(/[,\n]/)
    .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean);
  return [...new Set(tags)];
}

/** The memories that contain every word of the query in their title, body or tags. */
export function matchesQuery(memory: Memory, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const haystack = `${memory.title} ${memory.body} ${memory.tags.join(" ")}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
