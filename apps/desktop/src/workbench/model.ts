import { formatAge } from "../chat/usageView";
import type { Anchor, EntryKind, EntryView, MemberView, TopicView, Toucher, WorkbenchView } from "../lib/workbench";
import type { SessionStatus } from "../lib/workspace";

export const KIND_LABEL: Record<EntryKind, string> = {
  decision: "Decision",
  claim: "Claim",
  question: "Question",
  done: "Done",
  note: "Note",
  directive: "Directive",
};

export type KindFilter = "all" | "decision" | "question" | "claim" | "done";

export const KIND_FILTERS: readonly { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "decision", label: "Decisions" },
  { id: "question", label: "Questions" },
  { id: "claim", label: "Claims" },
  { id: "done", label: "Done" },
];

/** How many tints there are: past this many agents two share one. */
export const TINTS = 6;

/** An agent's tint, 1 to `TINTS`, by the order they joined; `null` for the developer or an agent that left. */
export function tintOf(sessionId: string | null, members: readonly { sessionId: string }[]): number | null {
  if (!sessionId) {
    return null;
  }
  const index = members.findIndex((member) => member.sessionId === sessionId);
  return index < 0 ? null : (index % TINTS) + 1;
}

/** The first letter or digit of a name, for the avatar. */
export function initialOf(name: string): string {
  const found = /[\p{L}\p{N}]/u.exec(name);
  return found ? found[0].toUpperCase() : "?";
}

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
export function ageOf(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? "" : formatAge(then / 1000, now / 1000);
}

/** Minutes left of a claim, or `null` when it has no end or it is over. */
export function minutesLeft(expiresAt: string | null, now: number = Date.now()): number | null {
  if (!expiresAt) {
    return null;
  }
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end) || end <= now) {
    return null;
  }
  return Math.max(1, Math.round((end - now) / 60_000));
}

/** Not news any more: given up, set aside, replaced, or a claim that ran out. */
export function isHistory(entry: EntryView): boolean {
  return (
    entry.state === "released" ||
    entry.state === "dismissed" ||
    entry.state === "superseded" ||
    (entry.kind === "claim" && !entry.live)
  );
}

export function matchesKind(entry: EntryView, filter: KindFilter): boolean {
  if (filter === "all") {
    return true;
  }
  // The developer's directives are decisions too.
  if (filter === "decision") {
    return entry.kind === "decision" || entry.kind === "directive";
  }
  return entry.kind === filter;
}

export function matchesQuery(entry: EntryView, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const haystack = [
    entry.text,
    entry.why ?? "",
    entry.topic ?? "",
    entry.authorLabel,
    KIND_LABEL[entry.kind],
    entry.toLabel ?? "",
    entry.paths.join(" "),
    entry.anchor?.path ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export type Filters = {
  kind: KindFilter;
  query: string;
  /** Only what this agent wrote or was told. */
  agent: string | null;
  /** Also what is no longer in force. */
  history: boolean;
};

export function visibleEntries(entries: readonly EntryView[], filters: Filters): EntryView[] {
  return entries.filter(
    (entry) =>
      (filters.history || !isHistory(entry)) &&
      matchesKind(entry, filters.kind) &&
      matchesQuery(entry, filters.query) &&
      (filters.agent === null || entry.author === filters.agent || entry.to === filters.agent),
  );
}

/** How many entries each kind filter would show, so a filter says what is behind it. */
export function kindCounts(entries: readonly EntryView[], history: boolean): Record<KindFilter, number> {
  const counts: Record<KindFilter, number> = { all: 0, decision: 0, question: 0, claim: 0, done: 0 };
  for (const entry of entries) {
    if (!history && isHistory(entry)) {
      continue;
    }
    for (const filter of KIND_FILTERS) {
      if (matchesKind(entry, filter.id)) {
        counts[filter.id] += 1;
      }
    }
  }
  return counts;
}

/** Entries the agents posted after the one the developer last saw; what the developer wrote is not news to them. */
export function newerThan(entries: readonly EntryView[], seenSeq: number): number {
  return entries.filter((entry) => entry.seq > seenSeq && entry.author !== null).length;
}

export type Tone = "working" | "needs" | "idle" | "done" | "bad";

/** What an agent is doing, as a word and a tone: never the colour alone. */
export function statusOf(member: Pick<MemberView, "status" | "finished">): { word: string; tone: Tone } {
  const status: SessionStatus = member.status;
  switch (status) {
    case "waiting-permission":
      return { word: "Needs approval", tone: "needs" };
    case "working":
    case "starting":
    case "stopping":
      return { word: "Working", tone: "working" };
    case "failed":
      return { word: "Failed", tone: "bad" };
    case "stopped":
      return { word: "Stopped", tone: "bad" };
    default:
      return member.finished ? { word: "Finished", tone: "done" } : { word: "Idle", tone: "idle" };
  }
}

export function summaryOf(view: Pick<WorkbenchView, "members" | "needsYou">) {
  const tones = view.members.map((member) => statusOf(member).tone);
  return {
    agents: view.members.length,
    working: tones.filter((tone) => tone === "working").length,
    finished: tones.filter((tone) => tone === "done").length,
    needs: view.needsYou.length,
  };
}

function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "3 agents · 2 working · 1 finished". */
export function summaryText(view: Pick<WorkbenchView, "members" | "needsYou">): string {
  const summary = summaryOf(view);
  const parts = [plural(summary.agents, "agent")];
  if (summary.working > 0) {
    parts.push(`${summary.working} working`);
  }
  if (summary.finished > 0) {
    parts.push(`${summary.finished} finished`);
  }
  return parts.join(" · ");
}

/** "src/a.rs:4-9 (feat/a@abc1234)". */
export function anchorText(anchor: Anchor): string {
  let text = anchor.path;
  if (anchor.startLine !== null) {
    text += anchor.endLine !== null && anchor.endLine !== anchor.startLine ? `:${anchor.startLine}-${anchor.endLine}` : `:${anchor.startLine}`;
  }
  return text;
}

/** "lines 10-12, 20". */
export function rangesText(ranges: readonly [number, number][]): string {
  if (ranges.length === 0) {
    return "";
  }
  const shown = ranges.slice(0, 3).map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`));
  const more = ranges.length > 3 ? ` +${ranges.length - 3}` : "";
  return `${ranges.length === 1 && ranges[0]![0] === ranges[0]![1] ? "line" : "lines"} ${shown.join(", ")}${more}`;
}

/** A path as its folder and its name, so the name can be read first. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { dir: "", name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

export type Badge = { label: string; tone: "neutral" | "attention" | "good" };

/** The state of an entry, when it has one worth saying. */
export function badgeOf(entry: EntryView): Badge | null {
  switch (entry.state) {
    case "contested":
      return { label: "Proposal", tone: "attention" };
    case "superseded":
      return { label: "Replaced", tone: "neutral" };
    case "answered":
      return { label: "Answered", tone: "good" };
    case "dismissed":
      return { label: "Set aside", tone: "neutral" };
    case "released":
      return { label: entry.kind === "directive" ? "Withdrawn" : "Released", tone: "neutral" };
    default:
      break;
  }
  if (entry.kind === "claim" && !entry.live) {
    return { label: "Lapsed", tone: "neutral" };
  }
  if (entry.kind === "question") {
    return entry.to === "developer" ? { label: "Needs you", tone: "attention" } : { label: "Open", tone: "neutral" };
  }
  return null;
}

/** Who an entry is for, in words; nothing when it is for everyone. */
export function addresseeOf(entry: EntryView): string | null {
  if (entry.to === null) {
    return null;
  }
  return entry.to === "developer" ? "you" : (entry.toLabel ?? "another agent");
}

/** What the agents agreed, as Markdown to paste into a chat, a document or a pull request. */
export function topicsMarkdown(topics: readonly TopicView[], workspaceName: string): string {
  const settled = topics.filter((topic) => topic.standing !== null);
  if (settled.length === 0) {
    return "";
  }
  const lines = [`# Decisions on the ${workspaceName} workbench`, ""];
  for (const topic of settled) {
    const standing = topic.standing!;
    lines.push(`## ${topic.topic}`, "", standing.text);
    const meta = [standing.kind === "directive" ? "the developer" : standing.authorLabel];
    if (standing.why) {
      meta.push(`why: ${standing.why}`);
    }
    if (standing.anchor) {
      meta.push(anchorText(standing.anchor) + (standing.anchor.rev ? ` (${standing.anchor.rev})` : ""));
    }
    lines.push("", `_${meta.join(" · ")}_`, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** The agents of a toucher list that changed a file, in the order of the members. */
export function touchersInOrder(touchers: readonly Toucher[], members: readonly MemberView[]): (Toucher | null)[] {
  return members.map((member) => touchers.find((toucher) => toucher.sessionId === member.sessionId) ?? null);
}

/** What a toucher did to a file, as a letter and a word. */
export function changeWord(change: Toucher["change"]): { letter: string; word: string } {
  switch (change) {
    case "added":
      return { letter: "A", word: "added" };
    case "deleted":
      return { letter: "D", word: "deleted" };
    case "renamed":
      return { letter: "R", word: "renamed" };
    default:
      return { letter: "M", word: "changed" };
  }
}
