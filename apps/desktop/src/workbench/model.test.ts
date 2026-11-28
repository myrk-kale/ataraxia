import { describe, expect, it } from "vitest";
import type { EntryView, MemberView, TopicView } from "../lib/workbench";
import {
  addresseeOf,
  ageOf,
  anchorText,
  badgeOf,
  initialOf,
  isHistory,
  kindCounts,
  minutesLeft,
  newerThan,
  rangesText,
  splitPath,
  statusOf,
  summaryText,
  tintOf,
  topicsMarkdown,
  visibleEntries,
  type Filters,
} from "./model";

function entry(over: Partial<EntryView>): EntryView {
  return {
    id: "e",
    seq: 1,
    workspaceId: "w",
    author: "a",
    authorLabel: "Agent A",
    kind: "note",
    state: "active",
    topic: null,
    text: "text",
    why: null,
    paths: [],
    anchor: null,
    to: null,
    replyTo: null,
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    shortId: "e",
    live: true,
    toLabel: null,
    ...over,
  };
}

function member(over: Partial<MemberView>): MemberView {
  return {
    sessionId: "a",
    title: "Agent A",
    provider: "claude",
    status: "idle",
    branch: null,
    joinedAt: "2026-01-01T00:00:00Z",
    now: null,
    holds: [],
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    unseen: 0,
    lastPostAt: null,
    finished: false,
    problem: null,
    ...over,
  };
}

const ALL: Filters = { kind: "all", query: "", agent: null, history: true };

describe("who is who", () => {
  it("tints agents by the order they joined, and the developer or an agent that left by none", () => {
    const members = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }];
    expect(tintOf("a", members)).toBe(1);
    expect(tintOf("c", members)).toBe(3);
    expect(tintOf(null, members)).toBeNull();
    expect(tintOf("gone", members)).toBeNull();
    // Past six agents the tints begin again.
    const many = Array.from({ length: 7 }, (_, n) => ({ sessionId: `s${n}` }));
    expect(tintOf("s6", many)).toBe(1);
  });

  it("takes the first letter or digit of a name for the avatar", () => {
    expect(initialOf("add retry")).toBe("A");
    expect(initialOf("  “éclair” fix")).toBe("É");
    expect(initialOf("2nd pass")).toBe("2");
    expect(initialOf("—")).toBe("?");
  });
});

describe("time", () => {
  const now = Date.parse("2026-01-01T01:00:00Z");

  it("says how long ago in the words the rest of the app uses", () => {
    expect(ageOf("2026-01-01T00:59:40Z", now)).toBe("just now");
    expect(ageOf("2026-01-01T00:48:00Z", now)).toBe("12 min ago");
    expect(ageOf("2025-12-31T22:00:00Z", now)).toBe("3 h ago");
    expect(ageOf("garbage", now)).toBe("");
  });

  it("counts the minutes a claim has left, and none once it has run out", () => {
    expect(minutesLeft("2026-01-01T01:30:00Z", now)).toBe(30);
    expect(minutesLeft("2026-01-01T01:00:10Z", now)).toBe(1);
    expect(minutesLeft("2026-01-01T00:59:00Z", now)).toBeNull();
    expect(minutesLeft(null, now)).toBeNull();
  });
});

describe("what the board shows", () => {
  const entries = [
    entry({ id: "1", seq: 1, kind: "decision", topic: "type:Money", text: "Money is cents", authorLabel: "Agent A" }),
    entry({ id: "2", seq: 2, kind: "claim", text: "the dispatcher", live: false }),
    entry({ id: "3", seq: 3, kind: "question", to: "developer", text: "yup or zod?", author: "b", authorLabel: "Agent B" }),
    entry({ id: "4", seq: 4, kind: "directive", author: null, authorLabel: "You", text: "use zod" }),
    entry({ id: "5", seq: 5, kind: "decision", state: "superseded", topic: "type:Money", text: "older" }),
    entry({ id: "6", seq: 6, kind: "done", text: "tests are in", author: "b", authorLabel: "Agent B" }),
  ];

  it("leaves out what is no longer in force unless asked", () => {
    expect(isHistory(entries[1]!)).toBe(true);
    expect(isHistory(entries[4]!)).toBe(true);
    expect(isHistory(entries[0]!)).toBe(false);
    expect(visibleEntries(entries, { ...ALL, history: false }).map((item) => item.id)).toEqual(["1", "3", "4", "6"]);
    expect(visibleEntries(entries, ALL)).toHaveLength(6);
  });

  it("filters by kind, counting the developer's directives as decisions", () => {
    expect(visibleEntries(entries, { ...ALL, history: false, kind: "decision" }).map((item) => item.id)).toEqual(["1", "4"]);
    expect(visibleEntries(entries, { ...ALL, kind: "question" }).map((item) => item.id)).toEqual(["3"]);
    expect(kindCounts(entries, false)).toEqual({ all: 4, decision: 2, question: 1, claim: 0, done: 1 });
    expect(kindCounts(entries, true).claim).toBe(1);
  });

  it("filters by an agent: what it wrote and what was told to it", () => {
    const told = [...entries, entry({ id: "7", seq: 7, author: "a", to: "b", text: "over to you" })];
    expect(visibleEntries(told, { ...ALL, agent: "b" }).map((item) => item.id)).toEqual(["3", "6", "7"]);
  });

  it("searches every word in the text, the topic, the author and the paths", () => {
    expect(visibleEntries(entries, { ...ALL, query: "money cents" }).map((item) => item.id)).toEqual(["1"]);
    expect(visibleEntries(entries, { ...ALL, query: "agent b" }).map((item) => item.id)).toEqual(["3", "6"]);
    const pathed = entry({ id: "8", paths: ["src/retry.rs"], text: "holding" });
    expect(visibleEntries([pathed], { ...ALL, query: "retry" })).toHaveLength(1);
    expect(visibleEntries(entries, { ...ALL, query: "nothing like this" })).toHaveLength(0);
  });

  it("counts what the agents posted after what the developer last saw, not the developer's own words", () => {
    expect(newerThan(entries, 4)).toBe(2);
    expect(newerThan(entries, 3)).toBe(2);
    expect(newerThan(entries, 6)).toBe(0);
    expect(newerThan(entries, 0)).toBe(5);
  });
});

describe("states in words", () => {
  it("gives a state a word, never only a colour", () => {
    expect(badgeOf(entry({ state: "contested", kind: "decision" }))).toEqual({ label: "Proposal", tone: "attention" });
    expect(badgeOf(entry({ state: "answered", kind: "question" }))?.label).toBe("Answered");
    expect(badgeOf(entry({ kind: "claim", live: false }))?.label).toBe("Lapsed");
    expect(badgeOf(entry({ kind: "claim", state: "released" }))?.label).toBe("Released");
    expect(badgeOf(entry({ kind: "directive", state: "released" }))?.label).toBe("Withdrawn");
    expect(badgeOf(entry({ kind: "question", to: "developer" }))).toEqual({ label: "Needs you", tone: "attention" });
    expect(badgeOf(entry({ kind: "question", to: "b" }))?.label).toBe("Open");
    expect(badgeOf(entry({ kind: "decision" }))).toBeNull();
  });

  it("says who an entry is for", () => {
    expect(addresseeOf(entry({}))).toBeNull();
    expect(addresseeOf(entry({ to: "developer" }))).toBe("you");
    expect(addresseeOf(entry({ to: "b", toLabel: "Agent B" }))).toBe("Agent B");
  });

  it("reads an agent's status as a word and a tone", () => {
    expect(statusOf({ status: "working", finished: false })).toEqual({ word: "Working", tone: "working" });
    expect(statusOf({ status: "waiting-permission", finished: false }).word).toBe("Needs approval");
    expect(statusOf({ status: "ready", finished: true })).toEqual({ word: "Finished", tone: "done" });
    expect(statusOf({ status: "idle", finished: false }).word).toBe("Idle");
    expect(statusOf({ status: "failed", finished: false }).tone).toBe("bad");
    // Working again after it finished: it is working.
    expect(statusOf({ status: "working", finished: true }).tone).toBe("working");
  });

  it("sums the board up in a line", () => {
    const view = {
      members: [member({ status: "working" }), member({ sessionId: "b", status: "idle", finished: true }), member({ sessionId: "c" })],
      needsYou: [],
    };
    expect(summaryText(view)).toBe("3 agents · 1 working · 1 finished");
    expect(summaryText({ members: [member({})], needsYou: [] })).toBe("1 agent");
  });
});

describe("places in the code", () => {
  it("writes an anchor and a set of lines", () => {
    expect(anchorText({ path: "src/a.rs", rev: null, startLine: 4, endLine: 9 })).toBe("src/a.rs:4-9");
    expect(anchorText({ path: "src/a.rs", rev: null, startLine: 4, endLine: 4 })).toBe("src/a.rs:4");
    expect(anchorText({ path: "src/a.rs", rev: "feat/a@abc", startLine: null, endLine: null })).toBe("src/a.rs");
    expect(rangesText([[10, 12]])).toBe("lines 10-12");
    expect(rangesText([[7, 7]])).toBe("line 7");
    expect(rangesText([[1, 2], [5, 5], [9, 9], [20, 30]])).toBe("lines 1-2, 5, 9 +1");
    expect(rangesText([])).toBe("");
  });

  it("splits a path so its name can be read first", () => {
    expect(splitPath("src/app/main.rs")).toEqual({ dir: "src/app/", name: "main.rs" });
    expect(splitPath("Cargo.lock")).toEqual({ dir: "", name: "Cargo.lock" });
  });
});

describe("the contract that emerged", () => {
  it("writes what stands as Markdown, and nothing when nothing stands", () => {
    const topic = (over: Partial<TopicView>): TopicView => ({
      topic: "type:Money",
      standing: null,
      proposals: [],
      heldBy: [],
      openQuestions: [],
      history: 0,
      updatedAt: "t",
      ...over,
    });
    expect(topicsMarkdown([topic({})], "demo")).toBe("");
    const text = topicsMarkdown(
      [
        topic({
          standing: entry({ kind: "decision", text: "Money is cents in an i64", why: "no float drift", anchor: { path: "src/money.rs", rev: "feat/a@abc", startLine: 3, endLine: null } }),
        }),
        topic({ topic: "lib:validation", standing: entry({ kind: "directive", author: null, authorLabel: "You", text: "use zod" }) }),
      ],
      "demo",
    );
    expect(text).toContain("# Decisions on the demo workbench");
    expect(text).toContain("## type:Money\n\nMoney is cents in an i64\n\n_Agent A · why: no float drift · src/money.rs:3 (feat/a@abc)_");
    expect(text).toContain("## lib:validation\n\nuse zod\n\n_the developer_");
    expect(text.endsWith("\n")).toBe(true);
  });
});
