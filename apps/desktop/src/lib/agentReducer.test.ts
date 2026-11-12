import { describe, expect, it } from "vitest";
import {
  chatReducer,
  initialChatState,
  type AgentEvent,
  type ChatState,
  type SubagentUpdate,
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
