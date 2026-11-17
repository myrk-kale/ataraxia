import { describe, expect, it } from "vitest";
import { advance } from "./autocomplete";

const word = (text: string) => ({ text, kind: "word" as const });

describe("keeping a suggestion while the person types it", () => {
  it("returns the suggestion for the text it was made for", () => {
    expect(advance({ draft: "corr", suggestion: word("igir") }, "corr")).toEqual(word("igir"));
  });

  it("shortens it as the suggested letters are typed", () => {
    expect(advance({ draft: "corr", suggestion: word("igir") }, "corri")).toEqual(word("gir"));
    expect(advance({ draft: "por fa", suggestion: { text: "vor revise", kind: "phrase" } }, "por favor")).toEqual({
      text: " revise",
      kind: "phrase",
    });
  });

  it("drops it when something else is typed, deleted, or it was all typed", () => {
    expect(advance({ draft: "corr", suggestion: word("igir") }, "corre")).toBeNull();
    expect(advance({ draft: "corr", suggestion: word("igir") }, "cor")).toBeNull();
    expect(advance({ draft: "corr", suggestion: word("igir") }, "corrigir")).toBeNull();
  });

  it("has nothing to keep when there was no suggestion", () => {
    expect(advance(null, "corr")).toBeNull();
    expect(advance({ draft: "corr", suggestion: null }, "corr")).toBeNull();
  });
});
