import { describe, expect, it } from "vitest";
import { markTerms } from "./search";

describe("marking what a search matched", () => {
  it("splits the text around each word of the term, whatever its case", () => {
    expect(markTerms("Fix the Login flow", "login fix")).toEqual([
      { text: "Fix", hit: true },
      { text: " the ", hit: false },
      { text: "Login", hit: true },
      { text: " flow", hit: false },
    ]);
  });

  it("leaves the text whole when there is nothing to mark", () => {
    expect(markTerms("nothing here", "zzz")).toEqual([{ text: "nothing here", hit: false }]);
    expect(markTerms("anything", "  ")).toEqual([{ text: "anything", hit: false }]);
    expect(markTerms("", "a")).toEqual([{ text: "", hit: false }]);
  });

  it("takes characters that mean something in a pattern as plain text", () => {
    expect(markTerms("a.b (c) a+b", "(c) a+b")).toEqual([
      { text: "a.b ", hit: false },
      { text: "(c)", hit: true },
      { text: " ", hit: false },
      { text: "a+b", hit: true },
    ]);
  });
});
