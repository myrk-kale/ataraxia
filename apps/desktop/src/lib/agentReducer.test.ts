import { describe, expect, it } from "vitest";
import {
  chatReducer,
  initialChatState,
  type AgentEvent,
  type ChatState,
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
        restoredCount: 3,
        status: "ready",
        pendingPermission: null,
      },
    });
    expect(state).toMatchObject({ loaded: true, restoredCount: 3, status: "ready" });
  });
});
