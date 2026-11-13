import type { Artifact, Decision, DecisionCommit, DecisionDetail, DecisionKind, DecisionMessage, DecisionState } from "../lib/insights";

export const KIND_LABEL: Record<DecisionKind, string> = {
  "api-contract": "API contract",
  "data-integrity": "Data integrity",
  behavior: "Behavior",
  security: "Security",
  dependencies: "Dependencies",
  performance: "Performance",
  "code-organization": "Code organization",
  ux: "UX",
  other: "Other",
};

/** A decision is open until someone settles it, like an issue. */
export const STATE_LABEL: Record<DecisionState, string> = {
  pending: "Open",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
};

export type Tab = "open" | "closed";

export const isOpen = (decision: Pick<Decision, "state">) => decision.state === "pending";

/** Newest first, as an issue list is. */
export function orderDecisions(decisions: readonly Decision[]): Decision[] {
  return [...decisions].sort((a, b) => b.seq - a.seq);
}

export function countByTab(decisions: readonly Decision[]): Record<Tab, number> {
  const open = decisions.filter(isOpen).length;
  return { open, closed: decisions.length - open };
}

/** The decisions of one tab whose number, title, summary or kind contain every word typed. */
export function filterDecisions(decisions: readonly Decision[], tab: Tab, query: string): Decision[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return orderDecisions(decisions).filter((decision) => {
    if ((tab === "open") !== isOpen(decision)) {
      return false;
    }
    const haystack = `#${decision.seq} ${decision.title} ${decision.summary} ${KIND_LABEL[decision.kind]}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** "just now", "5 minutes ago", "3 days ago", then the date. */
export function ago(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "";
  }
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"} ago`;
  if (seconds < 45) {
    return "just now";
  }
  if (seconds < 3600) {
    return unit(Math.max(1, Math.round(seconds / 60)), "minute");
  }
  if (seconds < 86_400) {
    return unit(Math.round(seconds / 3600), "hour");
  }
  if (seconds < 86_400 * 30) {
    return unit(Math.round(seconds / 86_400), "day");
  }
  return new Date(then).toLocaleDateString();
}

/** Who opened it, in words: `you`, `the agent`, or `claude · sonnet`. */
export function openedBy(decision: Pick<Decision, "opened_by">): string {
  switch (decision.opened_by) {
    case "":
      return "the agent";
    case "you":
      return "you";
    case "agent":
      return "the agent in chat";
    default:
      return decision.opened_by;
  }
}

export type TimelineEvent =
  | { kind: "message"; at: string; message: DecisionMessage }
  | { kind: "commit"; at: string; commit: DecisionCommit }
  | { kind: "state"; at: string; text: string };

const STATE_EVENT: Record<string, string> = {
  "state:approved": "You approved this decision",
  "state:rejected": "You rejected this decision",
  "state:pending": "You reopened this decision",
};

/** The discussion, the linked commits and the verdicts in the order they happened. */
export function buildTimeline(detail: Pick<DecisionDetail, "messages" | "commits" | "revisions">): TimelineEvent[] {
  const events: TimelineEvent[] = [
    ...detail.messages.map((message): TimelineEvent => ({ kind: "message", at: message.created_at, message })),
    ...detail.commits.map((commit): TimelineEvent => ({ kind: "commit", at: commit.created_at, commit })),
    ...detail.revisions.flatMap((revision): TimelineEvent[] => {
      const text = STATE_EVENT[revision.reason];
      return text ? [{ kind: "state", at: revision.created_at, text }] : [];
    }),
  ];
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export type Generation =
  | { kind: "idle" }
  | { kind: "working"; artifact: Artifact; label: string }
  | { kind: "failed"; artifact: Artifact; label: string; message: string };

/** `claude · sonnet`, or just the provider when no model was picked. */
export function generationLabel(artifact: Pick<Artifact, "provenance">): string {
  const provider = typeof artifact.provenance.provider === "string" ? artifact.provenance.provider : "";
  const model = typeof artifact.provenance.model === "string" ? artifact.provenance.model : "";
  return [provider, model].filter(Boolean).join(" · ") || "the agent";
}

/** Where the newest request for decisions stands. Older runs no longer matter once a newer one exists. */
export function generationState(artifacts: readonly Artifact[]): Generation {
  const latest = artifacts
    .filter((item) => item.kind === "decision")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (!latest) {
    return { kind: "idle" };
  }
  const label = generationLabel(latest);
  if (latest.status === "queued" || latest.status === "running") {
    return { kind: "working", artifact: latest, label };
  }
  if (latest.status === "failed") {
    return { kind: "failed", artifact: latest, label, message: latest.error ?? "The run failed." };
  }
  return { kind: "idle" };
}

export function refLabel(ref: { path: string; start_line: number | null; end_line: number | null }): string {
  if (ref.start_line === null) {
    return ref.path;
  }
  return ref.end_line && ref.end_line !== ref.start_line
    ? `${ref.path}:${ref.start_line}-${ref.end_line}`
    : `${ref.path}:${ref.start_line}`;
}
