import { describe, expect, it } from "vitest";
import {
  diffLines,
  parseToolInput,
  toolSummary,
  unifiedDiffLines,
} from "./toolSummary";

describe("toolSummary", () => {
  it("prefers the command of a shell call", () => {
    expect(toolSummary('{"command":"ls -la","description":"list"}')).toBe(
      "ls -la",
    );
  });

  it("falls back to a path-like key", () => {
    expect(toolSummary('{"file_path":"/w/a.rs","content":"x"}')).toBe("/w/a.rs");
  });

  it("uses the first line of plain text and clips long ones", () => {
    expect(toolSummary("touch a\ntouch b")).toBe("touch a");
    expect(toolSummary("x".repeat(200))).toHaveLength(90);
  });

  it("is empty when there is nothing to describe", () => {
    expect(toolSummary("")).toBe("");
    expect(toolSummary('{"unrelated":1}')).toBe("");
  });
});

describe("parseToolInput", () => {
  it("distinguishes empty, JSON objects and text", () => {
    expect(parseToolInput("  ").kind).toBe("empty");
    expect(parseToolInput('{"a":1}')).toEqual({
      kind: "fields",
      fields: [["a", 1]],
    });
    expect(parseToolInput("[1,2]").kind).toBe("text");
    expect(parseToolInput("pwd")).toEqual({ kind: "text", text: "pwd" });
  });
});

describe("diff helpers", () => {
  it("marks removed and added lines of a string pair", () => {
    expect(diffLines("a", "b\nc")).toEqual([
      { kind: "remove", text: "a" },
      { kind: "add", text: "b" },
      { kind: "add", text: "c" },
    ]);
  });

  it("classifies unified diff lines and ignores file headers", () => {
    const kinds = unifiedDiffLines("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new").map(
      (line) => line.kind,
    );
    expect(kinds).toEqual(["context", "context", "context", "remove", "add"]);
  });
});
