// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { announceSettled, DRAFT_SETTLED_EVENT, draftChats, isDraftChat, markDraftChat, settleDraftChat } from "./draftChats";

afterEach(() => window.localStorage.clear());

describe("a chat made with + before its first message", () => {
  it("is a draft until it is settled", () => {
    markDraftChat("a");
    markDraftChat("a");
    markDraftChat("b");
    expect([...draftChats()]).toEqual(["a", "b"]);
    settleDraftChat("a");
    expect(isDraftChat("a")).toBe(false);
    expect(isDraftChat("b")).toBe(true);
  });

  it("tells the shell once when its first message settles it", () => {
    const heard: string[] = [];
    const listener = (event: Event) => heard.push(String((event as CustomEvent).detail));
    window.addEventListener(DRAFT_SETTLED_EVENT, listener);
    markDraftChat("c");
    announceSettled("c");
    announceSettled("c");
    announceSettled("never-a-draft");
    window.removeEventListener(DRAFT_SETTLED_EVENT, listener);
    expect(heard).toEqual(["c"]);
  });
});
