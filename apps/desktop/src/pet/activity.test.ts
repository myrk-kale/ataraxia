import { describe, expect, it } from "vitest";
import type { SessionId } from "../lib/workspace";
import { QUIET, applyEvent, summarize, type ChatActivity } from "./activity";

const id = (name: string) => name as SessionId;
const chats = (entries: Record<string, Partial<ChatActivity>>) => new Map(Object.entries(entries).map(([key, value]) => [id(key), { ...QUIET, ...value }]));
const titles = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([key, value]) => [id(key), value]));
const names = { a: "Refactor uploads", b: "Fix the login", c: "Docs" };

describe("what the companion says", () => {
  it("is idle when nothing is going on", () => {
    expect(summarize(chats({ a: {}, b: { status: "ready" } }), titles(names)).state).toBe("idle");
    expect(summarize(new Map(), new Map()).text).toBe("");
  });

  it("says a chat is working, or how many are", () => {
    expect(summarize(chats({ a: { status: "working" } }), titles(names))).toMatchObject({ state: "running", sessionId: "a", text: "Working: Refactor uploads" });
    expect(summarize(chats({ a: { status: "working" }, b: { status: "starting" } }), titles(names))).toMatchObject({ state: "running", count: 2, text: "Working on 2 chats" });
  });

  it("puts what needs the person first, then what failed, then what is done, then what works", () => {
    const all = chats({ a: { status: "working" }, b: { unread: true }, c: { failed: true } });
    expect(summarize(all, titles(names)).state).toBe("blocked");
    all.set(id("a"), { ...QUIET, needsInput: true });
    expect(summarize(all, titles(names))).toMatchObject({ state: "needs-input", sessionId: "a", text: "Needs you: Refactor uploads" });
    expect(summarize(chats({ b: { unread: true }, a: { status: "working" } }), titles(names)).state).toBe("ready");
  });

  it("counts the others in the same state", () => {
    const all = chats({ a: { unread: true }, b: { unread: true }, c: { unread: true } });
    expect(summarize(all, titles(names))).toMatchObject({ state: "ready", count: 3, text: "Done: Refactor uploads and 2 more" });
  });

  it("treats a chat waiting for permission as one that needs the person, and a failed status as blocked", () => {
    expect(summarize(chats({ a: { status: "waiting-permission" } }), titles(names)).state).toBe("needs-input");
    expect(summarize(chats({ a: { status: "failed" } }), titles(names)).state).toBe("blocked");
  });

  it("ignores what is not a chat of the person's (a helper's session, a chat that was deleted)", () => {
    expect(summarize(chats({ hidden: { status: "working" } }), titles(names)).state).toBe("idle");
  });
});

describe("what an event does", () => {
  it("follows a turn: working, asking, done", () => {
    let chat = applyEvent(QUIET, { type: "status", status: "working" });
    expect(chat.status).toBe("working");
    chat = applyEvent(chat, { type: "permission" });
    expect(chat.needsInput).toBe(true);
    chat = applyEvent(chat, { type: "turnDone", ok: true });
    expect(chat).toMatchObject({ needsInput: false, unread: true, failed: false });
  });

  it("marks a turn that ended badly, and an error", () => {
    expect(applyEvent(QUIET, { type: "turnDone", ok: false })).toMatchObject({ failed: true, unread: false });
    expect(applyEvent({ ...QUIET, needsInput: true }, { type: "error" })).toMatchObject({ failed: true, needsInput: false });
    expect(applyEvent(QUIET, { type: "status", status: "failed" }).failed).toBe(true);
  });

  it("starts the next piece of work clean, so old news does not linger", () => {
    const old = { ...QUIET, unread: true, failed: true };
    expect(applyEvent(old, { type: "status", status: "working" })).toMatchObject({ unread: false, failed: false });
    expect(applyEvent(old, { type: "status", status: "ready" })).toMatchObject({ unread: true, failed: true });
  });

  it("leaves what it does not know alone", () => {
    expect(applyEvent(QUIET, { type: "delta" })).toBe(QUIET);
  });
});
