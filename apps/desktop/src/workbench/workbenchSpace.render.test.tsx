// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryView, FileRow, MemberView, NeedView, TopicView, WorkbenchView } from "../lib/workbench";
import type { ChatSession } from "../lib/workspace";
import { useWorkbench } from "./useWorkbench";
import { WorkbenchSpace } from "./WorkbenchSpace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The segmented control measures and animates itself; jsdom can do neither.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(Element.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => [];

const A = "a-1";
const B = "b-2";

let board: WorkbenchView;
let failing: string | null = null;
/** Commands that fail, with why. */
const rejecting: Record<string, string> = {};
const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
let pushed: ((event: { payload: unknown }) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd in rejecting) {
      return Promise.reject(new Error(rejecting[cmd]));
    }
    if (cmd === "workbench_view") {
      return failing ? Promise.reject(new Error(failing)) : Promise.resolve(JSON.parse(JSON.stringify(board)));
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (event: { payload: unknown }) => void) => {
    pushed = handler;
    return Promise.resolve(() => undefined);
  },
}));

function entry(over: Partial<EntryView>): EntryView {
  return {
    id: "e",
    seq: 1,
    workspaceId: "ws1",
    author: A,
    authorLabel: "Add retry",
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
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    shortId: "e",
    live: true,
    toLabel: null,
    ...over,
  };
}

function member(over: Partial<MemberView>): MemberView {
  return {
    sessionId: A,
    title: "Add retry",
    provider: "claude",
    status: "working",
    branch: "feat/retry",
    joinedAt: "2026-01-01T00:00:00Z",
    now: "Writing the retry policy",
    holds: ["src/retry.rs"],
    filesChanged: 3,
    additions: 40,
    deletions: 5,
    unseen: 1,
    lastPostAt: null,
    finished: false,
    problem: null,
    ...over,
  };
}

const decision = entry({ id: "d1", seq: 3, kind: "decision", topic: "type:Money", text: "Money is cents in an i64", why: "no float drift" });
const proposal = entry({ id: "p1", seq: 4, kind: "decision", state: "contested", author: B, authorLabel: "Fix uploads", topic: "type:Money", text: "Money is dollars as f64" });
const question = entry({ id: "q1", seq: 5, kind: "question", author: B, authorLabel: "Fix uploads", to: "developer", topic: "lib:validation", text: "yup or zod?" });
const claim = entry({ id: "c1", seq: 2, kind: "claim", text: "Writing the retry policy", paths: ["src/retry.rs"], expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
const note = entry({ id: "n1", seq: 1, author: B, authorLabel: "Fix uploads", text: "the build is slow today" });

const topics: TopicView[] = [
  { topic: "type:Money", standing: decision, proposals: [proposal], heldBy: [], openQuestions: [], history: 0, updatedAt: "t" },
];
const files: FileRow[] = [
  {
    repositoryId: "r1",
    repository: "demo",
    path: "src/dispatcher.rs",
    generated: false,
    severity: "collision",
    destructive: false,
    heldBy: null,
    touchers: [
      { sessionId: A, change: "modified", additions: 3, deletions: 1, ranges: [[10, 12]], clash: true },
      { sessionId: B, change: "modified", additions: 2, deletions: 0, ranges: [[11, 13]], clash: true },
    ],
  },
  {
    repositoryId: "r1",
    repository: "demo",
    path: "src/retry.rs",
    generated: false,
    severity: "clear",
    destructive: false,
    heldBy: A,
    touchers: [{ sessionId: A, change: "added", additions: 30, deletions: 0, ranges: [], clash: false }],
  },
];
const needs: NeedView[] = [
  { kind: "question", entryId: "q1", sessionIds: [B], title: "Fix uploads asks you", detail: "yup or zod?", path: null },
  { kind: "disagreement", entryId: "p1", sessionIds: [B, A], title: "Add retry and Fix uploads disagree on type:Money", detail: "Money is dollars as f64", path: null },
  { kind: "collision", entryId: null, sessionIds: [A, B], title: "Add retry and Fix uploads are changing the same lines", detail: "src/dispatcher.rs", path: "src/dispatcher.rs" },
];

function fullBoard(): WorkbenchView {
  return {
    workspaceId: "ws1",
    members: [member({}), member({ sessionId: B, title: "Fix uploads", status: "ready", now: null, holds: [], filesChanged: 1, additions: 2, deletions: 0, unseen: 0, branch: "fix/uploads" })],
    entries: [question, proposal, decision, claim, note],
    topics,
    files,
    needsYou: needs,
    latestSeq: 5,
  };
}

const chat = (id: string, title: string): ChatSession => ({
  id,
  repository_id: "r1",
  worktree_id: "w1",
  provider: "claude",
  title,
  status: "ready",
  model: null,
  effort: null,
  agent: null,
  created_at: "t",
  updated_at: "t",
  last_opened_at: null,
});

let host: HTMLDivElement;
let root: Root;
const opened: string[] = [];
const errors: string[] = [];
const files_opened: [string, number | null][] = [];

function Harness({
  workspaceId = "ws1",
  visible = true,
  chats = [chat(A, "Add retry"), chat(B, "Fix uploads"), chat("c-3", "Docs pass")],
}: {
  workspaceId?: string | null;
  visible?: boolean;
  chats?: ChatSession[];
}) {
  const state = useWorkbench(workspaceId, visible);
  return (
    <WorkbenchSpace
      board={state}
      chats={chats}
      visible={visible}
      workspaceId={workspaceId}
      workspaceName="demo"
      worktrees={[]}
      onError={(message) => errors.push(message)}
      onOpenChat={(id) => opened.push(id)}
      onOpenFile={(path, line) => files_opened.push([path, line])}
    />
  );
}

async function flush() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.resolve();
  });
}

async function mount(props: Parameters<typeof Harness>[0] = {}) {
  await act(async () => root.render(<Harness {...props} />));
  await flush();
}

const buttons = (within: ParentNode = host) => [...within.querySelectorAll("button")];
const buttonNamed = (name: string, within: ParentNode = host) => buttons(within).find((button) => button.textContent?.trim() === name || button.getAttribute("aria-label") === name);
const tray = () => host.querySelector<HTMLElement>('section[aria-label="Needs you"]')!;
const sent = (cmd: string) => calls.filter((call) => call.cmd === cmd);

async function click(element: Element | null | undefined) {
  expect(element, "an element to press").toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await flush();
}

async function write(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function enter(field: Element) {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  board = fullBoard();
  failing = null;
  for (const key of Object.keys(rejecting)) {
    delete rejecting[key];
  }
  pushed = null;
  calls.length = 0;
  opened.length = 0;
  errors.length = 0;
  files_opened.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("following the agents", () => {
  it("shows what each agent is doing, what waits for the developer and what was said", async () => {
    await mount();
    const text = host.textContent ?? "";
    expect(text).toContain("2 agents · 1 working");
    // The cards: what it said it is doing, what it holds, how much it changed, whether it has read.
    expect(text).toContain("Writing the retry policy");
    expect(text).toContain("src/retry.rs");
    expect(text).toContain("3 files");
    expect(text).toContain("Has not read 1 newer post");
    expect(text).toContain("feat/retry");
    // What waits for the developer is apart from the stream.
    expect(tray().textContent).toContain("Needs you");
    expect(tray().textContent).toContain("3");
    expect(tray().textContent).toContain("Fix uploads asks you");
    // The stream says who, what kind and about what.
    const stream = host.querySelector('ol[aria-label="Entries, newest first"]')!;
    expect(stream.textContent).toContain("Money is cents in an i64");
    expect(stream.textContent).toContain("Why: no float drift");
    expect(stream.textContent).toContain("type:Money");
    expect(stream.textContent).toContain("Proposal");
    expect(stream.textContent).toContain("the build is slow today");
    expect(stream.textContent).toContain("5 min ago");
  });

  it("opens the first thing that waits and keeps the rest a press away", async () => {
    await mount();
    const heads = buttons(tray()).filter((button) => button.hasAttribute("aria-expanded") && button.getAttribute("aria-expanded") !== null);
    // The fold of the whole tray, then one line per item.
    const items = heads.filter((button) => button.textContent?.includes("asks you") || button.textContent?.includes("disagree") || button.textContent?.includes("same lines"));
    expect(items.map((button) => button.getAttribute("aria-expanded"))).toEqual(["true", "false", "false"]);
    await click(items[1]);
    expect(buttonNamed("Adopt the proposal", tray())).toBeTruthy();
    // Opening one closes the first: one at a time.
    expect(buttonNamed("Answer", tray())).toBeFalsy();
  });

  it("folds the whole tray and opens it again", async () => {
    await mount();
    const fold = buttons(tray()).find((button) => button.textContent?.startsWith("Needs you"))!;
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    await click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(tray().querySelector("ul")!.className).toContain("hidden");
    await click(fold);
    expect(tray().querySelector("ul")!.className).not.toContain("hidden");
  });

  it("says so when the board cannot be read, and tries again", async () => {
    failing = "the engine is busy";
    await mount();
    expect(host.textContent).toContain("The workbench did not open: the engine is busy");
    failing = null;
    await click(buttonNamed("Try again"));
    expect(host.textContent).toContain("Writing the retry policy");
  });

  it("keeps the board on screen when a later read fails, and says why", async () => {
    await mount();
    failing = "the engine is busy";
    await act(async () => pushed!({ payload: { type: "workbench", workspaceId: "ws1" } }));
    await flush();
    expect(host.textContent).toContain("Could not refresh: the engine is busy");
    expect(host.textContent).toContain("Writing the retry policy");
  });

  it("reads the board again when the app says it changed, and only for its own workspace", async () => {
    await mount();
    const before = sent("workbench_view").length;
    await act(async () => pushed!({ payload: { type: "workbench", workspaceId: "somewhere-else" } }));
    await flush();
    expect(sent("workbench_view").length).toBe(before);
    await act(async () => pushed!({ payload: { type: "workbench", workspaceId: "ws1" } }));
    await flush();
    expect(sent("workbench_view").length).toBeGreaterThan(before);
  });

  it("marks what the agents posted since the developer last looked, and lets them mark it read", async () => {
    await mount();
    expect(host.textContent).not.toContain("Mark as read");
    board = { ...fullBoard(), latestSeq: 6, entries: [entry({ id: "n2", seq: 6, author: B, authorLabel: "Fix uploads", text: "uploads are retried too" }), ...fullBoard().entries] };
    await act(async () => pushed!({ payload: { type: "workbench", workspaceId: "ws1" } }));
    await flush();
    const mark = buttons().find((button) => button.textContent?.includes("Mark as read"))!;
    expect(mark.textContent).toContain("1 new");
    expect(host.querySelector('ol[aria-label="Entries, newest first"] li')!.textContent).toContain("New");
    await click(mark);
    expect(host.textContent).not.toContain("Mark as read");
  });
});

describe("being away", () => {
  it("makes what was posted while the developer was elsewhere new when they come back", async () => {
    await mount();
    expect(host.textContent).not.toContain("Mark as read");
    // The developer goes to another space: the board is still read now and then.
    await act(async () => root.render(<Harness visible={false} />));
    await flush();
    board = { ...fullBoard(), latestSeq: 6, entries: [entry({ id: "n2", seq: 6, author: B, authorLabel: "Fix uploads", text: "uploads are retried too" }), ...fullBoard().entries] };
    await act(async () => pushed!({ payload: { type: "workbench", workspaceId: "ws1" } }));
    await flush();
    // Still nothing marked: the screen is not on show, and what it showed when it left was all read.
    await act(async () => root.render(<Harness visible />));
    await flush();
    const mark = buttons().find((button) => button.textContent?.includes("Mark as read"));
    expect(mark?.textContent).toContain("1 new");
    expect(host.querySelector('ol[aria-label="Entries, newest first"] li')!.textContent).toContain("uploads are retried too");
  });

  it("does not read the board on a timer while nobody is on it and the screen is not on show", async () => {
    board = { ...fullBoard(), members: [], entries: [], needsYou: [], files: [], topics: [] };
    await mount({ visible: false });
    const first = sent("workbench_view").length;
    expect(first).toBeGreaterThan(0);
    // An event for a board with nobody on it is not worth a read either.
    await act(async () => pushed!({ payload: { type: "workbench", workspaceId: "ws1" } }));
    await flush();
    expect(sent("workbench_view").length).toBe(first);
  });
});

describe("doing something about it", () => {
  it("answers a question put to the developer, and the answer goes to that entry", async () => {
    await mount();
    await click(buttonNamed("Answer", tray()));
    const field = tray().querySelector<HTMLTextAreaElement>('textarea[aria-label="Your answer"]')!;
    await write(field, "zod");
    await enter(field);
    expect(sent("workbench_reply")[0]?.args).toEqual({ entryId: "q1", text: "zod" });
    // The board is read again to show what that did.
    expect(sent("workbench_view").length).toBeGreaterThan(1);
  });

  it("keeps what was typed, and says why, when the answer could not be sent", async () => {
    await mount();
    await click(buttonNamed("Answer", tray()));
    const field = tray().querySelector<HTMLTextAreaElement>('textarea[aria-label="Your answer"]')!;
    await write(field, "zod");
    rejecting.workbench_reply = "no connection";
    await enter(field);
    expect(errors.at(-1)).toContain("no connection");
    expect(tray().querySelector<HTMLTextAreaElement>('textarea[aria-label="Your answer"]')!.value).toBe("zod");
    // Once it can be sent, the same words go out.
    delete rejecting.workbench_reply;
    await enter(tray().querySelector('textarea[aria-label="Your answer"]')!);
    expect(sent("workbench_reply").at(-1)?.args).toEqual({ entryId: "q1", text: "zod" });
  });

  it("adopts a proposal against what stands, or keeps what stands", async () => {
    await mount();
    const head = buttons(tray()).find((button) => button.textContent?.includes("disagree"))!;
    await click(head);
    expect(tray().textContent).toContain("Money is cents in an i64");
    expect(tray().textContent).toContain("Money is dollars as f64");
    await click(buttonNamed("Adopt the proposal", tray()));
    expect(sent("workbench_resolve")[0]?.args).toEqual({ entryId: "p1", resolution: "adopt" });
    await click(buttonNamed("Keep what stands", tray()));
    expect(sent("workbench_resolve")[1]?.args).toEqual({ entryId: "p1", resolution: "dismiss" });
  });

  it("tells every agent on the same lines to settle it between them", async () => {
    await mount();
    const head = buttons(tray()).find((button) => button.textContent?.includes("same lines"))!;
    await click(head);
    expect(tray().textContent).toContain("src/dispatcher.rs");
    expect(tray().textContent).toContain("lines 10-12");
    expect(tray().textContent).toContain("lines 11-13");
    await click(buttonNamed("Tell them to settle it", tray()));
    const told = sent("workbench_direct");
    expect(told.map((call) => call.args?.to)).toEqual([A, B]);
    expect(told[0]?.args?.text).toContain("You and Fix uploads changed the same lines of src/dispatcher.rs");
    expect(told[1]?.args?.text).toContain("You and Add retry changed the same lines");
    expect(told.every((call) => call.args?.workspaceId === "ws1" && call.args?.topic === null)).toBe(true);
    expect(tray().textContent).toContain("Told them");
  });

  it("settles a proposal and answers an agent from the stream", async () => {
    await mount();
    const stream = host.querySelector('ol[aria-label="Entries, newest first"]')!;
    const row = [...stream.querySelectorAll("li")].find((item) => item.textContent?.includes("Money is dollars as f64"))!;
    await click(buttonNamed("Keep the current one", row));
    expect(sent("workbench_resolve")[0]?.args).toEqual({ entryId: "p1", resolution: "dismiss" });
    const noteRow = [...stream.querySelectorAll("li")].find((item) => item.textContent?.includes("the build is slow today"))!;
    await click(buttonNamed("Reply to Fix uploads", noteRow));
    const field = noteRow.querySelector<HTMLTextAreaElement>("textarea")!;
    await write(field, "noted, thanks");
    await enter(field);
    expect(sent("workbench_reply")[0]?.args).toEqual({ entryId: "n1", text: "noted, thanks" });
  });

  it("lets go of a claim", async () => {
    await mount();
    const stream = host.querySelector('ol[aria-label="Entries, newest first"]')!;
    const row = [...stream.querySelectorAll("li")].find((item) => item.textContent?.includes("Writing the retry policy"))!;
    expect(row.textContent).toContain("About 30 min left");
    await click(buttonNamed("Release", row));
    expect(sent("workbench_resolve")[0]?.args).toEqual({ entryId: "c1", resolution: "release" });
  });

  it("opens the code an entry points at", async () => {
    board = { ...fullBoard(), entries: [entry({ id: "d9", seq: 9, kind: "decision", topic: "type:Money", text: "cents", anchor: { path: "src/money.rs", rev: "feat/a@abc", startLine: 3, endLine: 9 } })] };
    await mount();
    await click(buttons().find((button) => button.textContent?.includes("src/money.rs:3-9")));
    expect(files_opened).toEqual([["src/money.rs", 3]]);
  });
});

describe("the developer's word", () => {
  const composer = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Tell the agents"]')!;

  it("tells everyone, with Enter, and the field is empty again", async () => {
    await mount();
    await write(composer(), "keep function names in English");
    await enter(composer());
    expect(sent("workbench_direct")[0]?.args).toEqual({ workspaceId: "ws1", text: "keep function names in English", to: null, topic: null });
    expect(composer().value).toBe("");
  });

  it("tells one agent when its card is pressed, and everyone again when it is released", async () => {
    await mount();
    const card = buttons().find((button) => button.getAttribute("aria-label")?.startsWith("Fix uploads:"))!;
    await click(card);
    expect(card.getAttribute("aria-pressed")).toBe("true");
    expect(buttons().some((button) => button.textContent?.includes("Tell one agent"))).toBe(true);
    await write(composer(), "mind the lockfile");
    await enter(composer());
    expect(sent("workbench_direct")[0]?.args?.to).toBe(B);
    await click(card);
    expect(card.getAttribute("aria-pressed")).toBe("false");
    expect(buttons().some((button) => button.textContent?.includes("Tell everyone"))).toBe(true);
  });

  it("makes it the decision on a topic, and needs the topic for that", async () => {
    await mount();
    await click(buttonNamed("Decide a topic"));
    await write(composer(), "zod, not yup");
    await enter(composer());
    expect(sent("workbench_direct")).toHaveLength(0);
    await write(host.querySelector<HTMLInputElement>('input[aria-label="Topic"]')!, "lib:validation");
    await enter(composer());
    expect(sent("workbench_direct")[0]?.args).toEqual({ workspaceId: "ws1", text: "zod, not yup", to: null, topic: "lib:validation" });
  });

  it("does not send nothing", async () => {
    await mount();
    await write(composer(), "   ");
    await enter(composer());
    expect(sent("workbench_direct")).toHaveLength(0);
  });
});

describe("finding one's way", () => {
  const stream = () => host.querySelector('ol[aria-label="Entries, newest first"]')!;
  const rows = () => [...stream().querySelectorAll(":scope > li")].map((item) => item.textContent ?? "");

  it("narrows the board to one agent and brings the others back", async () => {
    await mount();
    expect(rows()).toHaveLength(5);
    await click(buttons().find((button) => button.getAttribute("aria-label")?.startsWith("Fix uploads:")));
    // What it wrote and what was told to it.
    expect(rows().every((row) => row.includes("Fix uploads"))).toBe(true);
    expect(host.textContent).toContain("Only Fix uploads");
    await click(buttonNamed("Show every agent again"));
    expect(rows()).toHaveLength(5);
  });

  it("filters by kind, counting each", async () => {
    await mount();
    const filter = buttons().find((button) => button.textContent?.startsWith("Questions"))!;
    expect(filter.textContent).toContain("1");
    await click(filter);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("yup or zod?");
    expect(filter.getAttribute("aria-pressed")).toBe("true");
  });

  it("searches every word", async () => {
    await mount();
    await write(host.querySelector<HTMLInputElement>('input[aria-label="Search the board"]')!, "slow build");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("the build is slow today");
    await write(host.querySelector<HTMLInputElement>('input[aria-label="Search the board"]')!, "no such thing");
    expect(host.textContent).toContain("Nothing matches");
    await click(buttonNamed("Clear the filters"));
    expect(rows()).toHaveLength(5);
  });

  it("shows what is no longer in force only when asked", async () => {
    board = { ...fullBoard(), entries: [...fullBoard().entries, entry({ id: "old", seq: 0, kind: "decision", state: "superseded", text: "an older decision" })] };
    await mount();
    expect(rows().some((row) => row.includes("an older decision"))).toBe(false);
    await click(buttonNamed("History"));
    expect(rows().some((row) => row.includes("an older decision"))).toBe(true);
  });

  it("shows the decisions by topic, and copies them as Markdown", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: (text: string) => (written.push(text), Promise.resolve()) }, configurable: true });
    await mount();
    await click(host.querySelector('[role="tab"][id$="topics"]') ?? [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith("Topics")));
    expect(host.textContent).toContain("Disputed");
    expect(host.textContent).toContain("Money is cents in an i64");
    expect(host.textContent).toContain("Proposed by Fix uploads");
    await click(buttonNamed("Copy decisions"));
    expect(written[0]).toContain("# Decisions on the demo workbench");
    expect(written[0]).toContain("## type:Money");
    expect(written[0]).toContain("Money is cents in an i64");
  });

  it("shows who touches which file, the same lines first and in words", async () => {
    await mount();
    await click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith("Files")));
    const table = host.querySelector("table")!;
    const lines = [...table.querySelectorAll("tbody tr")].map((row) => row.textContent ?? "");
    expect(lines[0]).toContain("dispatcher.rs");
    expect(lines[0]).toContain("Same lines");
    expect(lines[0]).toContain("lines 10-12");
    expect(lines[1]).toContain("retry.rs");
    expect(lines[1]).toContain("Held by Add retry");
    // A cell says what happened, not only that something did.
    const marks = [...table.querySelectorAll('[role="img"]')].map((mark) => mark.getAttribute("aria-label"));
    expect(marks).toContain("Add retry changed it, plus 3, minus 1, lines 10-12, on top of another agent");
    expect(marks.some((label) => label?.includes("did not touch it"))).toBe(true);
  });
});

describe("who is on the board", () => {
  it("lists the chats that could join when none is on it, and puts one on", async () => {
    board = { ...fullBoard(), members: [], entries: [], needsYou: [], files: [], topics: [] };
    await mount();
    expect(host.textContent).toContain("Put agents on the workbench");
    expect(host.textContent).toContain("git worktree add");
    const join = buttons().filter((button) => button.textContent === "Add to the board");
    expect(join).toHaveLength(3);
    await click(join[2]);
    expect(sent("workbench_join")[0]?.args).toEqual({ sessionId: "c-3" });
  });

  it("takes a chat off the board, and opens its chat", async () => {
    await mount();
    await click(buttonNamed("Take Fix uploads off the workbench"));
    expect(sent("workbench_leave")[0]?.args).toEqual({ sessionId: B });
    await click(buttonNamed("Open the chat of Add retry"));
    expect(opened).toEqual([A]);
  });

  it("adds one of the other chats from the rail", async () => {
    await mount();
    await click(buttons().find((button) => button.textContent?.startsWith("Add a chat")));
    const choices = host.querySelectorAll('ul[aria-label="Chats that can join"] button');
    expect(choices).toHaveLength(1);
    expect(choices[0]!.textContent).toContain("Docs pass");
    await click(choices[0]);
    expect(sent("workbench_join")[0]?.args).toEqual({ sessionId: "c-3" });
  });

  it("asks for a workspace when there is none", async () => {
    await mount({ workspaceId: null });
    expect(host.textContent).toContain("Open a workspace first");
    expect(sent("workbench_view")).toHaveLength(0);
  });

  it("clears the board only after asking", async () => {
    await mount();
    await click(buttonNamed("Clear board"));
    expect(host.textContent).toContain("Delete every entry?");
    expect(sent("workbench_clear")).toHaveLength(0);
    await click(buttonNamed("Keep"));
    expect(host.textContent).not.toContain("Delete every entry?");
    await click(buttonNamed("Clear board"));
    await click(buttonNamed("Clear the board"));
    expect(sent("workbench_clear")[0]?.args).toEqual({ workspaceId: "ws1" });
  });
});
