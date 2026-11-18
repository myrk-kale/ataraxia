// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { forgetClosedSubagents, loadClosedSubagents, saveClosedSubagents } from "./closedSubagents";

afterEach(() => window.localStorage.clear());

describe("subagents closed in a chat", () => {
  it("stay closed when the chat is opened again", () => {
    saveClosedSubagents("chat-1", new Set(["a", "b"]));
    expect([...loadClosedSubagents("chat-1")]).toEqual(["a", "b"]);
    expect(loadClosedSubagents("chat-2").size).toBe(0);
  });

  it("are forgotten with the chat, and a damaged entry reads as none", () => {
    saveClosedSubagents("chat-1", new Set(["a"]));
    forgetClosedSubagents("chat-1");
    expect(loadClosedSubagents("chat-1").size).toBe(0);
    window.localStorage.setItem("ataraxia.closedSubagents.chat-3", "{not json");
    expect(loadClosedSubagents("chat-3").size).toBe(0);
  });
});
