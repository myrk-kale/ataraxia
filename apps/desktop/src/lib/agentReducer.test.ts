import { describe, expect, it } from "vitest";
import {
  chatReducer,
  initialChatState,
  type AgentEvent,
  type ChatState,
  type SubagentUpdate,
  withLocal,
} from "./agent";

const SESSION = "s1";
const TURN = "t1";

function apply(state: ChatState, ...events: AgentEvent[]): ChatState {
  return events.reduce(
    (current, event) => chatReducer(current, { type: "event", event }),
    state,
  );
}

describe("chatReducer", () => {
  it("merges consecutive deltas of the same turn and role", () => {
    const state = apply(
      initialChatState,
      { type: "delta", sessionId: SESSION, turnId: TURN, role: "user", text: "hi" },
      { type: "delta", sessionId: SESSION, turnId: TURN, role: "assistant", text: "Hel" },
      { type: "delta", sessionId: SESSION, turnId: TURN, role: "assistant", text: "lo" },
    );
    expect(state.items).toHaveLength(2);
    expect(state.items[1]).toMatchObject({ kind: "message", text: "Hello" });
  });

  it("starts a new message after a tool call", () => {
    const state = apply(
      initialChatState,
      { type: "delta", sessionId: SESSION, turnId: TURN, role: "assistant", text: "a" },
      { type: "tool", sessionId: SESSION, turnId: TURN, callId: "c1", name: "bash", input: "" },
      { type: "delta", sessionId: SESSION, turnId: TURN, role: "assistant", text: "b" },
    );
    expect(state.items.map((item) => item.kind)).toEqual([
      "message",
      "tool",
      "message",
    ]);
  });

  it("tracks a tool from announcement to result", () => {
    const state = apply(
      initialChatState,
      { type: "tool", sessionId: SESSION, turnId: TURN, callId: "c1", name: "bash", input: "" },
      { type: "toolUpdate", sessionId: SESSION, turnId: TURN, callId: "c1", name: null, input: "ls" },
      { type: "toolResult", sessionId: SESSION, turnId: TURN, callId: "c1", output: "a", ok: true },
    );
    expect(state.items[0]).toMatchObject({
      kind: "tool",
      name: "bash",
      input: "ls",
      output: "a",
      status: "done",
    });
  });

  it("sets and clears the pending permission", () => {
    const asked = apply(initialChatState, {
      type: "permission",
      sessionId: SESSION,
      turnId: TURN,
      requestId: "r1",
      toolName: "bash",
      detail: "Allow?",
    });
    expect(asked.pending?.requestId).toBe("r1");
    const done = apply(asked, {
      type: "turnDone",
      sessionId: SESSION,
      turnId: TURN,
      ok: false,
    });
    expect(done.pending).toBeNull();
  });

  it("fails tools still running when the turn ends unsuccessfully", () => {
    const state = apply(
      initialChatState,
      { type: "tool", sessionId: SESSION, turnId: TURN, callId: "c1", name: "bash", input: "" },
      { type: "turnDone", sessionId: SESSION, turnId: TURN, ok: false },
    );
    expect(state.items[0]).toMatchObject({ status: "failed" });
  });

  it("loads a snapshot including how many items were restored", () => {
    const state = chatReducer(initialChatState, {
      type: "loaded",
      snapshot: {
        items: [],
        subagents: [],
        restoredCount: 3,
        status: "ready",
        pendingPermission: null,
      },
    });
    expect(state).toMatchObject({ loaded: true, restoredCount: 3, status: "ready" });
  });

  describe("subagents", () => {
    const sub = (update: SubagentUpdate, title = "Explore"): AgentEvent => ({
      type: "subagent",
      sessionId: SESSION,
      subagentId: "sa1",
      title,
      update,
    });

    it("builds a subagent conversation apart from the main one", () => {
      const state = apply(
        initialChatState,
        sub({ kind: "started" }),
        sub({ kind: "delta", text: "Look" }),
        sub({ kind: "delta", text: "ing" }),
        sub({ kind: "tool", callId: "c1", name: "grep", input: "main" }),
        sub({ kind: "toolResult", callId: "c1", output: "3 hits", ok: true }),
        sub({ kind: "done", ok: true }),
      );
      expect(state.items).toEqual([]);
      expect(state.subagents).toHaveLength(1);
      const [agent] = state.subagents;
      expect(agent).toMatchObject({ title: "Explore", status: "done" });
      expect(agent.items[0]).toMatchObject({ kind: "message", text: "Looking" });
      expect(agent.items[1]).toMatchObject({ kind: "tool", status: "done", output: "3 hits" });
    });

    it("creates the subagent on its first event and keeps the latest title", () => {
      const state = apply(
        initialChatState,
        sub({ kind: "delta", text: "hi" }, "Subagent"),
        sub({ kind: "delta", text: "!" }, "Review the diff"),
      );
      expect(state.subagents).toHaveLength(1);
      expect(state.subagents[0].title).toBe("Review the diff");
      expect(state.subagents[0].status).toBe("running");
    });

    it("shows what the user sent to a subagent and marks it as working again", () => {
      const state = apply(
        initialChatState,
        sub({ kind: "delta", text: "Done." }),
        sub({ kind: "done", ok: true }),
        sub({ kind: "user", text: "also check the tests" }),
        sub({ kind: "delta", text: "On it." }),
      );
      const [agent] = state.subagents;
      expect(agent.status).toBe("running");
      expect(agent.items.map((item) => item.kind === "message" && [item.role, item.text])).toEqual([
        ["assistant", "Done."],
        ["user", "also check the tests"],
        ["assistant", "On it."],
      ]);
    });

    it("keeps a background subagent running past the turn that launched it", () => {
      const state = apply(
        initialChatState,
        sub({ kind: "detached" }),
        { type: "turnDone", sessionId: SESSION, turnId: TURN, ok: true },
      );
      expect(state.subagents[0]).toMatchObject({ status: "running", detached: true });
      const finished = apply(state, sub({ kind: "delta", text: "Result." }), sub({ kind: "done", ok: true }));
      expect(finished.subagents[0]).toMatchObject({ status: "done", detached: false });
    });

    it("closes subagents still running when the main turn ends", () => {
      const state = apply(
        initialChatState,
        sub({ kind: "tool", callId: "c1", name: "grep", input: "" }),
        { type: "turnDone", sessionId: SESSION, turnId: TURN, ok: false },
      );
      expect(state.subagents[0].status).toBe("failed");
      expect(state.subagents[0].items[0]).toMatchObject({ status: "failed" });
    });

    it("loads subagents from a snapshot", () => {
      const state = chatReducer(initialChatState, {
        type: "loaded",
        snapshot: {
          items: [],
          subagents: [{ id: "sa9", title: "Old", status: "done", items: [] }],
          restoredCount: 0,
          status: "ready",
          pendingPermission: null,
        },
      });
      expect(state.subagents.map((item) => item.id)).toEqual(["sa9"]);
    });
  });
});

describe("a message shown before the app has taken it in", () => {
  const ready: ChatState = { ...initialChatState, loaded: true, status: "ready" };
  const sent = (state = ready, text = "fix the bug", images: { id: string; name: string; mime: string }[] = []) =>
    chatReducer(state, { type: "optimistic", id: "pending:1", text, images });
  const user = (text: string, turnId = "t1", images?: { id: string; name: string; mime: string }[]) =>
    ({ type: "delta", sessionId: "s1", turnId, role: "user", text, ...(images ? { images } : {}) }) as const;

  it("puts the message in the transcript and the agent at work at once", () => {
    const state = sent();
    expect(state.status).toBe("working");
    expect(state.items).toEqual([
      { kind: "message", id: "pending:1", role: "user", text: "fix the bug", turnId: null, pending: true },
    ]);
  });

  it("clears an error the last send left, since this is a new try", () => {
    expect(sent({ ...ready, error: "it broke" }).error).toBeNull();
  });

  it("keeps the pictures that were attached", () => {
    const state = sent(ready, "look", [{ id: "local:1", name: "a.png", mime: "image/png" }]);
    expect((state.items[0] as { images?: unknown[] }).images).toHaveLength(1);
  });

  it("becomes the real message when the app reports it, in the same place and under the same key", () => {
    const before = chatReducer(
      sent(chatReducer(ready, { type: "event", event: user("earlier", "t0") })),
      { type: "event", event: { type: "status", sessionId: "s1", status: "working" } },
    );
    const after = chatReducer(before, { type: "event", event: user("fix the bug") });
    expect(after.items).toHaveLength(2);
    expect(after.items[1]).toMatchObject({ id: "pending:1", text: "fix the bug", turnId: "t1", pending: false });
    expect(after.items.some((item) => item.kind === "message" && item.pending)).toBe(false);
  });

  it("a second report of the same text is a second message, since only one was waiting", () => {
    const once = chatReducer(sent(), { type: "event", event: user("fix the bug") });
    const twice = chatReducer(once, { type: "event", event: user("fix the bug", "t2") });
    expect(twice.items.filter((item) => item.kind === "message" && item.role === "user")).toHaveLength(2);
  });

  it("takes the app's pictures in place of the local ones", () => {
    const state = sent(ready, "look", [{ id: "local:1", name: "a.png", mime: "image/png" }]);
    const after = chatReducer(state, {
      type: "event",
      event: user("look", "t1", [{ id: "img-9", name: "a.png", mime: "image/png" }]),
    });
    expect((after.items[0] as { images: { id: string }[] }).images.map((i) => i.id)).toEqual(["img-9"]);
  });

  it("leaves a message that is not ours alone, and keeps waiting for ours", () => {
    const after = chatReducer(sent(), { type: "event", event: user("a note from BTW", "t9") });
    expect(after.items).toHaveLength(2);
    expect(after.items[0]).toMatchObject({ pending: true });
    expect(after.items[1]).toMatchObject({ text: "a note from BTW" });
  });

  it("matches the text without the space round it, as the app trims it", () => {
    const after = chatReducer(sent(ready, "  fix the bug \n"), { type: "event", event: user("fix the bug") });
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ pending: false });
  });

  it("does not touch the assistant's messages or a user message when none is waiting", () => {
    const after = chatReducer(ready, { type: "event", event: user("hello") });
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ text: "hello" });
  });

  it("is withdrawn when the send fails, and the agent is as idle as before", () => {
    const state = sent();
    const back = chatReducer(state, { type: "rollback", id: "pending:1", status: "ready" });
    expect(back.items).toEqual([]);
    expect(back.status).toBe("ready");
  });

  it("is withdrawn alone: what was in the chat stays", () => {
    const earlier = chatReducer(ready, { type: "event", event: user("earlier", "t0") });
    const back = chatReducer(sent(earlier), { type: "rollback", id: "pending:1", status: "ready" });
    expect(back.items).toHaveLength(1);
    expect(back.items[0]).toMatchObject({ text: "earlier" });
  });

  it("never withdraws a message the app has already taken in, even if the send then reports a failure", () => {
    const taken = chatReducer(sent(), { type: "event", event: user("fix the bug") });
    const back = chatReducer(taken, { type: "rollback", id: "pending:1", status: "ready" });
    expect(back.items).toHaveLength(1);
    expect(back.items[0]).toMatchObject({ text: "fix the bug", pending: false });
  });
});

describe("the queue with what is on its way in", () => {
  const item = (id: string, text: string) => ({ id, text, images: [] as string[] });
  const local = (id: string, text: string, known: string[] = []) => ({ ...item(id, text), known: new Set(known) });

  it("is the app's own queue when nothing is on its way", () => {
    const queue = { items: [item("a", "one")], paused: false };
    expect(withLocal(queue, [])).toBe(queue);
  });

  it("lists what was sent after the app's entries, marked as being added", () => {
    const shown = withLocal({ items: [item("a", "one")], paused: false }, [local("pending:1", "two", ["a"])]);
    expect(shown.items.map((i) => [i.id, i.pending ?? false])).toEqual([
      ["a", false],
      ["pending:1", true],
    ]);
  });

  it("stops showing it once the app lists it, so it is never shown twice", () => {
    const shown = withLocal({ items: [item("a", "one"), item("b", "two")], paused: false }, [local("pending:1", "two", ["a"])]);
    expect(shown.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("does not mistake an older entry with the same text for the new one", () => {
    const shown = withLocal({ items: [item("a", "again")], paused: false }, [local("pending:1", "again", ["a"])]);
    expect(shown.items.map((i) => i.id)).toEqual(["a", "pending:1"]);
  });

  it("matches two sends of the same text to two entries, one each", () => {
    const sent = [local("pending:1", "same", []), local("pending:2", "same", [])];
    const one = withLocal({ items: [item("x", "same")], paused: false }, sent);
    expect(one.items.map((i) => i.id)).toEqual(["x", "pending:2"]);
    const both = withLocal({ items: [item("x", "same"), item("y", "same")], paused: false }, sent);
    expect(both.items.map((i) => i.id)).toEqual(["x", "y"]);
  });

  it("keeps the queue paused when it was", () => {
    expect(withLocal({ items: [], paused: true }, [local("pending:1", "x")]).paused).toBe(true);
  });
});

describe("an event that reaches the chat twice", () => {
  const ready: ChatState = { ...initialChatState, loaded: true, status: "ready" };
  const piece = (seq: number | undefined, text: string): AgentEvent => ({
    type: "delta",
    sessionId: "s1",
    turnId: "t1",
    role: "assistant",
    text,
    ...(seq === undefined ? {} : { seq }),
  });
  const text = (state: ChatState) => state.items.map((item) => (item.kind === "message" ? item.text : "")).join("|");

  it("is applied once, so streamed text is not doubled", () => {
    const pieces = ["Vou", " usar", " a", " skill"];
    let state = ready;
    pieces.forEach((word, i) => {
      // Each one is delivered twice, as if two listeners were attached.
      state = chatReducer(state, { type: "event", event: piece(i + 1, word) });
      state = chatReducer(state, { type: "event", event: piece(i + 1, word) });
    });
    expect(text(state)).toBe("Vou usar a skill");
  });

  it("without a number it would be doubled, which is what this guards against", () => {
    let state = ready;
    for (const word of ["Vou", " usar"]) {
      state = chatReducer(state, { type: "event", event: piece(undefined, word) });
      state = chatReducer(state, { type: "event", event: piece(undefined, word) });
    }
    expect(text(state)).toBe("VouVou usar usar");
  });

  it("applies the events in order and remembers the last number", () => {
    const state = [1, 2, 3].reduce((current, n) => chatReducer(current, { type: "event", event: piece(n, `${n}`) }), ready);
    expect(text(state)).toBe("123");
    expect(state.lastSeq).toBe(3);
  });

  it("ignores one older than what it has applied", () => {
    const state = chatReducer(chatReducer(ready, { type: "event", event: piece(5, "five") }), {
      type: "event",
      event: piece(3, " three"),
    });
    expect(text(state)).toBe("five");
    expect(state.lastSeq).toBe(5);
  });

  it("gives back the very same state when it ignores one, so nothing is drawn again", () => {
    const state = chatReducer(ready, { type: "event", event: piece(1, "a") });
    expect(chatReducer(state, { type: "event", event: piece(1, "a") })).toBe(state);
  });

  it("applies an event that has no number, as the events made without the app do", () => {
    const state = chatReducer(chatReducer(ready, { type: "event", event: piece(4, "a") }), {
      type: "event",
      event: piece(undefined, "b"),
    });
    expect(text(state)).toBe("ab");
  });

  it("holds for every kind of event: a tool is listed once and a status is set once", () => {
    const tool: AgentEvent = { type: "tool", sessionId: "s1", turnId: "t1", callId: "c1", name: "Bash", input: "{}", seq: 1 };
    let state = chatReducer(chatReducer(ready, { type: "event", event: tool }), { type: "event", event: tool });
    expect(state.items.filter((item) => item.kind === "tool")).toHaveLength(1);
    const done: AgentEvent = { type: "toolResult", sessionId: "s1", turnId: "t1", callId: "c1", output: "ok", ok: true, seq: 2 };
    state = chatReducer(chatReducer(state, { type: "event", event: done }), { type: "event", event: done });
    expect(state.items.filter((item) => item.kind === "tool")).toHaveLength(1);
  });

  it("is still not applied again after the chat is read afresh, so a late repeat does no harm", () => {
    const state = chatReducer(ready, { type: "event", event: piece(9, "nine") });
    const reread = chatReducer(state, {
      type: "loaded",
      snapshot: { items: [], subagents: [], restoredCount: 0, status: "ready", pendingPermission: null },
    });
    expect(reread.lastSeq).toBe(9);
    expect(chatReducer(reread, { type: "event", event: piece(9, "nine") })).toBe(reread);
  });

  it("does not make a message shown before the app took it in appear twice", () => {
    const user: AgentEvent = { type: "delta", sessionId: "s1", turnId: "t1", role: "user", text: "hello", seq: 1 };
    let state = chatReducer(ready, { type: "optimistic", id: "pending:1", text: "hello", images: [] });
    state = chatReducer(state, { type: "event", event: user });
    state = chatReducer(state, { type: "event", event: user });
    expect(state.items.filter((item) => item.kind === "message" && item.role === "user")).toHaveLength(1);
  });
});
