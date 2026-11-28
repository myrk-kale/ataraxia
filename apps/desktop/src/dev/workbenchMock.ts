// Browser-only stand-in for the workbench commands, so the screen can be reviewed with `pnpm dev`.
// `?workbench=empty` starts with no chat on the board; by default three agents are mid-task.
import type {
  EntryView,
  FileRow,
  MemberView,
  NeedView,
  Resolution,
  TopicView,
  WorkbenchView,
} from "../lib/workbench";
import type { ProviderKind, SessionStatus } from "../lib/workspace";

type Emit = (event: string, payload: unknown) => void;

const WORKSPACE = "ws1";
const preset = new URLSearchParams(window.location.search).get("workbench");

const people: Record<string, { title: string; provider: ProviderKind; status: SessionStatus; branch: string; finished: boolean; unseen: number; files: [number, number, number] }> = {
  s1: { title: "Refactor document generation", provider: "codex", status: "working", branch: "feature/course-mask", finished: false, unseen: 1, files: [4, 112, 18] },
  s2: { title: "Add retry to the dispatcher", provider: "claude", status: "working", branch: "feat/dispatcher-retry", finished: false, unseen: 2, files: [3, 57, 9] },
  s3: { title: "Explain the worker lifecycle", provider: "opencode", status: "ready", branch: "docs/worker-lifecycle", finished: true, unseen: 0, files: [2, 64, 0] },
};

let members: string[] = preset === "empty" ? [] : ["s1", "s2", "s3"];
let seq = 0;
let entries: EntryView[] = [];

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const minutesAhead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

function add(over: Partial<EntryView> & Pick<EntryView, "kind" | "text">, ago: number): EntryView {
  seq += 1;
  const author = over.author === undefined ? "s1" : over.author;
  const entry: EntryView = {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    seq,
    workspaceId: WORKSPACE,
    author,
    authorLabel: author === null ? "You" : (people[author]?.title ?? "Agent"),
    state: "active",
    topic: null,
    why: null,
    paths: [],
    anchor: null,
    to: null,
    replyTo: null,
    expiresAt: null,
    createdAt: minutesAgo(ago),
    updatedAt: minutesAgo(ago),
    shortId: "",
    live: true,
    toLabel: null,
    ...over,
  };
  entry.shortId = entry.id.slice(0, 8);
  entries.push(entry);
  return entry;
}

function seed() {
  seq = 0;
  entries = [];
  if (preset === "empty") {
    return;
  }
  add({ kind: "claim", author: "s1", text: "Writing the retry policy", topic: "type:RetryPolicy", paths: ["src/studio/retry.py"], expiresAt: minutesAhead(41) }, 38);
  add({ kind: "claim", author: "s2", text: "Wiring the dispatcher to the policy", paths: ["src/studio/dispatcher.py"], expiresAt: minutesAhead(33) }, 36);
  add(
    {
      kind: "decision",
      author: "s1",
      topic: "type:RetryPolicy",
      text: "RetryPolicy(max_attempts: int, backoff_ms: int) lives in src/studio/retry.py; the dispatcher only calls policy.next_delay().",
      why: "One place to tune retries, and the dispatcher stays free of timing rules.",
      anchor: { path: "src/studio/retry.py", rev: "feature/course-mask@a1b2c3d", startLine: 4, endLine: 18 },
    },
    33,
  );
  const asked = add({ kind: "question", author: "s2", to: "s1", toLabel: people.s1!.title, topic: "type:RetryPolicy", text: "Does the dispatcher catch Timeout, or does the policy?" }, 21);
  asked.state = "answered";
  add(
    { kind: "note", author: "s1", to: "s2", toLabel: people.s2!.title, replyTo: asked.id, topic: "type:RetryPolicy", text: "The policy retries Timeout. The dispatcher only reports the final failure." },
    19,
  );
  add(
    {
      kind: "decision",
      author: "s3",
      topic: "lib:test-runner",
      text: "pytest with the existing fixtures. No new test framework.",
      why: "The suite already runs in CI with it.",
    },
    17,
  );
  add(
    {
      kind: "decision",
      author: "s2",
      state: "contested",
      topic: "type:RetryPolicy",
      text: "Make backoff_ms optional with a default of 200, so callers can write RetryPolicy(3).",
      why: "Most call sites do not care about the delay.",
    },
    9,
  );
  add({ kind: "question", author: "s3", to: "developer", topic: "docs:retry", text: "Should the docs describe the retry limits in seconds or in attempts?" }, 6);
  add({ kind: "directive", author: null, text: "Keep public function names in English and add a one-line docstring to each." }, 5);
  add({ kind: "note", author: "s2", text: "Heads-up: poetry.lock changed in both of our worktrees. I will regenerate it after the merge, not by hand." }, 3);
  add(
    {
      kind: "done",
      author: "s3",
      text: "Tests for the uploader are in, and the worker lifecycle is written up.",
      anchor: { path: "tests/test_uploader.py", rev: "docs/worker-lifecycle@9f8e7d6", startLine: null, endLine: null },
      paths: ["docs/worker-lifecycle.md"],
    },
    1,
  );
}
seed();

const files = (): FileRow[] => {
  const on = (id: string) => members.includes(id);
  const rows: FileRow[] = [
    {
      repositoryId: "r1",
      repository: "archipelago-backend",
      path: "src/studio/dispatcher.py",
      generated: false,
      severity: "collision",
      destructive: false,
      heldBy: "s2",
      touchers: [
        { sessionId: "s1", change: "modified", additions: 22, deletions: 4, ranges: [[40, 61]], clash: true },
        { sessionId: "s2", change: "modified", additions: 31, deletions: 6, ranges: [[55, 70]], clash: true },
      ],
    },
    {
      repositoryId: "r1",
      repository: "archipelago-backend",
      path: "poetry.lock",
      generated: true,
      severity: "shared",
      destructive: false,
      heldBy: null,
      touchers: [
        { sessionId: "s1", change: "modified", additions: 6, deletions: 2, ranges: [], clash: false },
        { sessionId: "s2", change: "modified", additions: 4, deletions: 1, ranges: [], clash: false },
      ],
    },
    {
      repositoryId: "r1",
      repository: "archipelago-backend",
      path: "src/studio/retry.py",
      generated: false,
      severity: "clear",
      destructive: false,
      heldBy: "s1",
      touchers: [{ sessionId: "s1", change: "added", additions: 64, deletions: 0, ranges: [], clash: false }],
    },
    {
      repositoryId: "r1",
      repository: "archipelago-backend",
      path: "tests/test_uploader.py",
      generated: false,
      severity: "clear",
      destructive: false,
      heldBy: null,
      touchers: [{ sessionId: "s3", change: "added", additions: 48, deletions: 0, ranges: [], clash: false }],
    },
    {
      repositoryId: "r1",
      repository: "archipelago-backend",
      path: "docs/worker-lifecycle.md",
      generated: false,
      severity: "clear",
      destructive: false,
      heldBy: null,
      touchers: [{ sessionId: "s3", change: "added", additions: 16, deletions: 0, ranges: [], clash: false }],
    },
  ];
  return rows
    .map((row) => ({ ...row, touchers: row.touchers.filter((toucher) => on(toucher.sessionId)) }))
    .filter((row) => row.touchers.length > 0);
};

function memberViews(): MemberView[] {
  return members.map((id) => {
    const person = people[id]!;
    const claims = entries.filter((entry) => entry.author === id && entry.kind === "claim" && entry.live);
    const last = [...entries].reverse().find((entry) => entry.author === id);
    return {
      sessionId: id,
      title: person.title,
      provider: person.provider,
      status: person.status,
      branch: person.branch,
      joinedAt: minutesAgo(45),
      now: claims.at(-1)?.text ?? null,
      holds: claims.flatMap((claim) => (claim.paths.length > 0 ? claim.paths : claim.topic ? [claim.topic] : [])),
      filesChanged: person.files[0],
      additions: person.files[1],
      deletions: person.files[2],
      unseen: person.unseen,
      lastPostAt: last?.createdAt ?? null,
      finished: last?.kind === "done",
      problem: null,
    };
  });
}

function topicsOf(): TopicView[] {
  const by = new Map<string, TopicView>();
  for (const entry of entries) {
    if (!entry.topic) {
      continue;
    }
    const key = entry.topic.toLowerCase();
    const topic = by.get(key) ?? { topic: entry.topic, standing: null, proposals: [], heldBy: [], openQuestions: [], history: 0, updatedAt: entry.updatedAt };
    by.set(key, topic);
    if (entry.updatedAt > topic.updatedAt) {
      topic.updatedAt = entry.updatedAt;
    }
    if ((entry.kind === "decision" || entry.kind === "directive") && entry.state === "active") {
      topic.standing = entry;
    } else if (entry.kind === "decision" && entry.state === "contested") {
      topic.proposals.push(entry);
    } else if (entry.kind === "claim" && entry.live) {
      topic.heldBy.push(entry);
    } else if (entry.kind === "question" && entry.state === "active") {
      topic.openQuestions.push(entry);
    } else if (entry.state === "superseded") {
      topic.history += 1;
    }
  }
  return [...by.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function needsOf(rows: FileRow[]): NeedView[] {
  const needs: NeedView[] = [];
  const nameOf = (id: string) => people[id]?.title ?? "Agent";
  for (const entry of [...entries].reverse()) {
    if (entry.kind === "question" && entry.state === "active" && entry.to === "developer") {
      needs.push({ kind: "question", entryId: entry.id, sessionIds: entry.author ? [entry.author] : [], title: `${entry.authorLabel} asks you`, detail: entry.text, path: null });
    }
  }
  for (const entry of [...entries].reverse()) {
    if (entry.kind === "decision" && entry.state === "contested") {
      const standing = entries.find((other) => other.state === "active" && other.topic === entry.topic && other.kind !== "claim");
      needs.push({
        kind: "disagreement",
        entryId: entry.id,
        sessionIds: [entry.author, standing?.author].filter((id): id is string => Boolean(id)),
        title: `${standing?.authorLabel ?? "The standing decision"} and ${entry.authorLabel} disagree on ${entry.topic}`,
        detail: entry.text,
        path: null,
      });
    }
  }
  for (const row of rows.filter((item) => item.severity === "collision")) {
    const clashing = row.touchers.filter((toucher) => toucher.clash).map((toucher) => toucher.sessionId);
    needs.push({ kind: "collision", entryId: null, sessionIds: clashing, title: `${clashing.map(nameOf).join(" and ")} are changing the same lines`, detail: row.path, path: row.path });
  }
  return needs;
}

function view(): WorkbenchView {
  const rows = files();
  return {
    workspaceId: WORKSPACE,
    members: memberViews(),
    entries: [...entries].reverse(),
    topics: topicsOf(),
    files: rows,
    needsYou: needsOf(rows),
    latestSeq: seq,
  };
}

export function handleWorkbench(cmd: string, args: Record<string, unknown> | undefined, emit: Emit): { handled: boolean; value?: unknown } {
  const done = (value: unknown = null) => {
    emit("insight://event", { type: "workbench", workspaceId: WORKSPACE });
    return { handled: true, value };
  };
  switch (cmd) {
    case "workbench_view":
      return { handled: true, value: JSON.parse(JSON.stringify(view())) };
    case "workbench_join": {
      const id = String(args?.sessionId);
      if (!members.includes(id) && people[id]) {
        members = [...members, id];
      }
      return done();
    }
    case "workbench_leave":
      members = members.filter((id) => id !== args?.sessionId);
      return done();
    case "workbench_clear":
      entries = [];
      return done();
    case "workbench_direct": {
      const topic = typeof args?.topic === "string" && args.topic.trim() ? args.topic.trim() : null;
      const to = typeof args?.to === "string" ? args.to : null;
      if (topic) {
        for (const entry of entries) {
          if (entry.topic?.toLowerCase() === topic.toLowerCase() && (entry.kind === "decision" || entry.kind === "directive") && (entry.state === "active" || entry.state === "contested")) {
            entry.state = "superseded";
          }
        }
      }
      const made = add({ kind: "directive", author: null, text: String(args?.text ?? ""), topic, to, toLabel: to ? (people[to]?.title ?? null) : null }, 0);
      return done(made);
    }
    case "workbench_reply": {
      const target = entries.find((entry) => entry.id === args?.entryId);
      if (!target) {
        return { handled: true, value: null };
      }
      if (target.kind === "question") {
        target.state = "answered";
      }
      const made = add({ kind: "note", author: null, text: String(args?.text ?? ""), replyTo: target.id, topic: target.topic, to: target.author, toLabel: target.author ? (people[target.author]?.title ?? null) : null }, 0);
      return done(made);
    }
    case "workbench_resolve": {
      const target = entries.find((entry) => entry.id === args?.entryId);
      const resolution = args?.resolution as Resolution;
      if (!target) {
        return { handled: true, value: null };
      }
      if (resolution === "adopt" && target.topic) {
        for (const entry of entries) {
          if (entry.topic?.toLowerCase() === target.topic.toLowerCase() && (entry.kind === "decision" || entry.kind === "directive") && entry.state !== "superseded") {
            entry.state = "superseded";
          }
        }
        add({ kind: "directive", author: null, topic: target.topic, replyTo: target.id, text: `Decided: ${target.text} (the proposal of ${target.authorLabel} is adopted)` }, 0);
      } else if (resolution === "dismiss") {
        target.state = "dismissed";
      } else if (resolution === "release") {
        target.state = "released";
        target.live = false;
      }
      return done();
    }
    default:
      return { handled: false };
  }
}
