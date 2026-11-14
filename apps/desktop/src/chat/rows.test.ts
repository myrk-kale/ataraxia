import { describe, expect, it } from "vitest";
import type { ChatItem } from "../lib/agent";
import { estimateRow, GROUP_GAP, toRows, TURN_GAP } from "./rows";

const user = (id: string, text = id): ChatItem => ({ kind: "message", id, role: "user", text, turnId: null });
const agent = (id: string, text = id): ChatItem => ({ kind: "message", id, role: "assistant", text, turnId: "t" });
const tool = (callId: string): ChatItem => ({
  kind: "tool",
  callId,
  turnId: "t",
  name: "Bash",
  input: "",
  output: null,
  status: "done",
});

describe("toRows", () => {
  it("makes one row per message and tool call, so a long turn can be cut anywhere", () => {
    const rows = toRows([user("u1"), agent("a1"), tool("c1"), tool("c2"), agent("a2")], -1);
    expect(rows.map((row) => row.key)).toEqual(["u1", "a1", "c1", "c2", "a2"]);
  });

  it("keeps the small gap inside a turn and the large one between turns", () => {
    const rows = toRows([user("u1"), agent("a1"), tool("c1"), user("u2"), agent("a2")], -1);
    expect(rows.map((row) => row.after)).toEqual([TURN_GAP, GROUP_GAP, TURN_GAP, TURN_GAP, 0]);
  });

  it("leaves no space under the last row", () => {
    expect(toRows([user("u1")], -1)[0].after).toBe(0);
    expect(toRows([], -1)).toEqual([]);
  });

  it("puts the notice above the first row the running agent produced", () => {
    const rows = toRows([user("u1"), agent("a1"), agent("a2"), tool("c1")], 2);
    expect(rows.map((row) => row.notice)).toEqual([false, false, true, false]);
  });

  it("puts no notice anywhere without a split", () => {
    expect(toRows([user("u1"), agent("a1")], -1).some((row) => row.notice)).toBe(false);
  });

  it("keeps each item as it was, so an unchanged one can be recognised", () => {
    const first = agent("a1");
    const rows = toRows([user("u1"), first], -1);
    expect(rows[1].item).toBe(first);
  });
});

describe("estimateRow", () => {
  const row = (item: ChatItem, extra = {}) => ({ key: "k", item, after: 0, notice: false, ...extra });

  it("grows with the text", () => {
    expect(estimateRow(row(agent("a", "x".repeat(800))))).toBeGreaterThan(estimateRow(row(agent("a", "short"))));
    expect(estimateRow(row(agent("a", "a\nb\nc\nd")))).toBeGreaterThan(estimateRow(row(agent("a", "abcd"))));
  });

  it("counts the space below, the notice and pictures", () => {
    const base = estimateRow(row(user("u", "hi")));
    expect(estimateRow(row(user("u", "hi"), { after: 38 }))).toBe(base + 38);
    expect(estimateRow(row(user("u", "hi"), { notice: true }))).toBeGreaterThan(base);
    const withPicture = { ...user("u", "hi"), images: [{ id: "i", name: "n", mime: "image/png" }] } as ChatItem;
    expect(estimateRow(row(withPicture))).toBeGreaterThan(base);
  });

  it("is never zero", () => {
    expect(estimateRow(row(tool("c")))).toBeGreaterThan(0);
  });
});
