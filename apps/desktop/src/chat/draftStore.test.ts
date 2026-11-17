// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { forgetDraft, loadDraft, saveDraft } from "./draftStore";

afterEach(() => window.localStorage.clear());

describe("composer drafts", () => {
  it("keeps what was typed per chat", () => {
    saveDraft("a", "olá\nmundo");
    saveDraft("b", "outro");
    expect(loadDraft("a")).toBe("olá\nmundo");
    expect(loadDraft("b")).toBe("outro");
    expect(loadDraft("c")).toBe("");
  });

  it("leaves nothing behind once the draft is empty or forgotten", () => {
    saveDraft("a", "x");
    saveDraft("a", "");
    expect(window.localStorage.length).toBe(0);
    saveDraft("a", "y");
    forgetDraft("a");
    expect(loadDraft("a")).toBe("");
  });
});
