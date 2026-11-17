import { describe, expect, it } from "vitest";
import { completeWord, rememberWords } from "./autocomplete";

describe("local word completion", () => {
  it("suggests from the common vocabulary using a prefix", () => {
    expect(completeWord("common", "corr")).toBe("igir");
    expect(completeWord("common", "co")).toBeTruthy();
  });

  it("learns words typed in one chat and prefers frequent words", () => {
    rememberWords("learned", "xilofone xilofone xilema");
    expect(completeWord("learned", "xil")).toBe("ofone");
    expect(completeWord("another", "xil")).toBeNull();
  });

  it("ignores commands, mentions, short words and complete words", () => {
    expect(completeWord("common", "/corr")).toBeNull();
    expect(completeWord("common", "@corr")).toBeNull();
    expect(completeWord("common", "c")).toBeNull();
    expect(completeWord("common", "corrigir")).toBeNull();
  });

  it("matches accents and preserves the prefix the person typed", () => {
    rememberWords("accent", "configuração configuração");
    expect(completeWord("accent", "CONFIGU")).toBe("ração");
  });
});
