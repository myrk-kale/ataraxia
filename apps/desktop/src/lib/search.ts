import { invoke } from "@tauri-apps/api/core";
import type { RepositoryId, SessionId, WorkspaceId, WorktreeId } from "./workspace";

export const SEARCH_KINDS = {
  chat: "Conversation",
  message: "Message",
  subagent: "Subagent",
  checkpoint: "Checkpoint",
  flow: "Flow diagram",
  decision: "Decision artifact",
  decision_item: "Decision",
  review_priority: "Review priority",
  review_comment: "Review comment",
  btw: "BTW",
  task: "Task",
} as const;

export type SearchKind = keyof typeof SEARCH_KINDS;

export type SearchRequest = {
  query: string;
  kind: SearchKind | null;
  workspaceId: WorkspaceId | null;
  repositoryId: RepositoryId | null;
};

export type SearchResult = {
  documentId: number;
  kind: SearchKind;
  itemId: string;
  sessionId: SessionId | null;
  btwId: string | null;
  title: string;
  excerpt: string;
  workspace: string | null;
  repository: string | null;
  repositoryId: RepositoryId | null;
  path: string | null;
  line: number | null;
  checkpointId: string | null;
  worktreeId: WorktreeId | null;
};

export function isSearchReview(result: SearchResult): boolean {
  return result.kind === "checkpoint" || result.kind === "review_priority" || result.kind === "review_comment";
}

export type ConversationJump = { messageId?: string; subagentId?: string };

export function globalSearch(request: SearchRequest): Promise<SearchResult[]> {
  return invoke("global_search", { request });
}

/** `text` cut into the parts that match a word of `term` and the parts that do not. */
export function markTerms(text: string, term: string): { text: string; hit: boolean }[] {
  const words = [...new Set(term.toLowerCase().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (words.length === 0 || text === "") {
    return [{ text, hit: false }];
  }
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text
    .split(pattern)
    .filter((part) => part !== "")
    .map((part) => ({ text: part, hit: words.includes(part.toLowerCase()) }));
}
