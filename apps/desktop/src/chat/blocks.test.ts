import { describe, expect, it } from "vitest";
import type { ChatItem } from "../lib/agent";
import { toBlocks } from "./blocks";

const user = (id: string): ChatItem => ({
  kind: "message",
  id,
  role: "user",
  text: id,
  turnId: null,
});
const agent = (id: string): ChatItem => ({
  kind: "message",
  id,
  role: "assistant",
  text: id,
  turnId: "t",
});
const tool = (callId: string): ChatItem => ({
  kind: "tool",
  callId,
  turnId: "t",
  name: "Bash",
  input: "",
  output: null,
  status: "done",
});

describe("toBlocks", () => {
  it("groups consecutive agent messages and tool calls into one block", () => {
    const blocks = toBlocks([user("u1"), agent("a1"), tool("c1"), agent("a2")], -1);
    expect(blocks.map((block) => block.kind)).toEqual(["user", "agent"]);
    const reply = blocks[1];
    expect(reply?.kind === "agent" ? reply.items.length : 0).toBe(3);
  });

  it("starts a new block for every user message", () => {
    const blocks = toBlocks([user("u1"), agent("a1"), user("u2"), agent("a2")], -1);
    expect(blocks.map((block) => block.kind)).toEqual(["user", "agent", "user", "agent"]);
  });

  it("splits an agent block where the restored history ends", () => {
    const blocks = toBlocks([agent("a1"), agent("a2")], 1);
    expect(blocks.length).toBe(2);
  });
});
