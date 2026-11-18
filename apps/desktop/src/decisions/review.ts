import type { Decision } from "../lib/insights";

/** What a decision review shows: every decision of the chat that is not superseded, open ones first. */
export function reviewOrder(decisions: readonly Decision[]): Decision[] {
  return decisions
    .filter((decision) => decision.state !== "superseded")
    .sort((a, b) => {
      const open = Number(b.state === "pending") - Number(a.state === "pending");
      return open !== 0 ? open : a.seq - b.seq;
    });
}

export type ReviewTally = { total: number; pending: number; approved: number; rejected: number };

export function tally(decisions: readonly Decision[]): ReviewTally {
  const shown = reviewOrder(decisions);
  return {
    total: shown.length,
    pending: shown.filter((decision) => decision.state === "pending").length,
    approved: shown.filter((decision) => decision.state === "approved").length,
    rejected: shown.filter((decision) => decision.state === "rejected").length,
  };
}

/** A rejection needs a comment: it is what the agent will be told to act on. */
export function canReject(comment: string): boolean {
  return comment.trim().length > 0;
}

/** The line the chat's artifact card shows. */
export function cardLabel(counts: ReviewTally): string {
  if (counts.pending > 0) {
    return counts.pending === 1 ? "1 decision to review" : `${counts.pending} decisions to review`;
  }
  const parts = [`${counts.approved} approved`];
  if (counts.rejected > 0) {
    parts.push(`${counts.rejected} rejected`);
  }
  return `Reviewed: ${parts.join(", ")}`;
}
