import { describe, expect, it } from "vitest";
import { contextChip } from "./contextChip";

describe("contextChip", () => {
  it("says nothing when nothing is open", () => {
    expect(contextChip(null)).toBeNull();
  });

  it("names a selection by its file, lines and size", () => {
    expect(contextChip({ kind: "selection", label: "a.py", path: "src/a.py", startLine: 12, endLine: 20, text: "x\ny\nz" })).toBe(
      "Selection · src/a.py:12-20 · 3 lines",
    );
    expect(contextChip({ kind: "selection", label: "a.py", path: "a.py", startLine: 4, endLine: 4, text: "one line" })).toBe(
      "Selection · a.py:4 · 1 line",
    );
  });

  it("names a file, with the line the cursor is on", () => {
    expect(contextChip({ kind: "file", label: "a.py", path: "src/a.py" })).toBe("File · src/a.py");
    expect(contextChip({ kind: "file", label: "a.py", path: "src/a.py", startLine: 7, endLine: 7 })).toBe("File · src/a.py:7");
  });

  it("uses the label of anything else", () => {
    expect(contextChip({ kind: "decision", label: "Decision 4: Hash the tokens" })).toBe("Decision 4: Hash the tokens");
  });
});
