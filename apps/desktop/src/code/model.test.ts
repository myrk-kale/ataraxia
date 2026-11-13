import { describe, expect, it } from "vitest";
import type { Checkpoint, ReviewPriority, Unit } from "../lib/insights";
import {
  ancestors,
  describeTarget,
  shownLabel,
  unitQueue,
  buildTree,
  languageFor,
  latestOfTurns,
  lineChanges,
  mapLine,
  noDiffMessage,
  reviewQueue,
  stepIn,
  unchanged,
  visibleRows,
} from "./model";

describe("project tree", () => {
  const tree = buildTree(["src/b.ts", "README.md", "src/a/x.ts", "src/a/y.ts", "Cargo.toml"]);

  it("lists folders first, then files, alphabetically", () => {
    expect(tree.map((node) => node.name)).toEqual(["src", "Cargo.toml", "README.md"]);
    expect(tree[0]!.children.map((node) => node.name)).toEqual(["a", "b.ts"]);
  });

  it("shows only the rows of open folders", () => {
    expect(visibleRows(tree, new Set()).map((row) => row.node.path)).toEqual(["src", "Cargo.toml", "README.md"]);
    const open = visibleRows(tree, new Set(["src", "src/a"]));
    expect(open.map((row) => `${row.depth}:${row.node.path}`)).toEqual([
      "0:src",
      "1:src/a",
      "2:src/a/x.ts",
      "2:src/a/y.ts",
      "1:src/b.ts",
      "0:Cargo.toml",
      "0:README.md",
    ]);
  });

  it("knows the folders on the way to a file", () => {
    expect(ancestors("src/a/x.ts")).toEqual(["src", "src/a"]);
    expect(ancestors("README.md")).toEqual([]);
  });
});

describe("languages", () => {
  it("picks a Monaco language from the file name", () => {
    expect(languageFor("src/app.tsx")).toBe("typescript");
    expect(languageFor("a/b/Dockerfile")).toBe("dockerfile");
    expect(languageFor("main.rs")).toBe("rust");
    expect(languageFor("LICENSE")).toBe("plaintext");
  });
});

describe("line changes", () => {
  it("marks added, edited and removed lines on the right side", () => {
    const older = "a\nb\nc\nd";
    const newer = "a\nB\nc\nd\ne";
    const changes = lineChanges(older, newer);
    expect(changes.added).toEqual([2, 5]);
    expect(changes.removed).toEqual([2]);
  });

  it("handles new and emptied files", () => {
    expect(lineChanges("", "x\ny")).toEqual({ added: [1, 2], removed: [] });
    expect(lineChanges("x\ny", "")).toEqual({ added: [], removed: [1, 2] });
    expect(lineChanges("same", "same")).toEqual({ added: [], removed: [] });
  });

  it("keeps your place when switching versions", () => {
    const older = "a\nb\nc\nd";
    const newer = "NEW\na\nb\nc\nd";
    expect(mapLine(older, newer, 3, "older")).toBe(4);
    expect(mapLine(older, newer, 4, "newer")).toBe(3);
    expect(mapLine(older, newer, 1, "newer")).toBe(1);
  });

  it("does not choke on large files", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const result = lineChanges(big, big.replace("line 1500", "changed"));
    expect(result.added).toEqual([1501]);
  });
});

describe("review queue", () => {
  it("orders files by component score, then file score", () => {
    const queue = reviewQueue({
      components: [
        { id: "a", name: "a", files: ["a/low.ts", "a/high.ts"], score: 80, level: "high", additions: 0, deletions: 0, reasons: [] },
        { id: "b", name: "b", files: ["b/x.ts"], score: 20, level: "low", additions: 0, deletions: 0, reasons: [] },
      ],
      files: [
        { path: "a/low.ts", score: 10, level: "low", reasons: [], additions: 0, deletions: 0, change: "modified" },
        { path: "a/high.ts", score: 80, level: "high", reasons: [], additions: 0, deletions: 0, change: "modified" },
        { path: "b/x.ts", score: 20, level: "low", reasons: [], additions: 0, deletions: 0, change: "modified" },
      ],
    });
    expect(queue).toEqual(["a/high.ts", "a/low.ts", "b/x.ts"]);
    expect(reviewQueue(null)).toEqual([]);
  });

  it("steps through any list without leaving it", () => {
    expect(stepIn(["a", "b", "c"], "a", 1)).toBe("b");
    expect(stepIn(["a", "b", "c"], "c", 1)).toBe("c");
    expect(stepIn(["a", "b", "c"], "a", -1)).toBe("a");
    expect(stepIn(["a", "b"], null, 1)).toBe("a");
    expect(stepIn(["a", "b"], "zzz", -1)).toBe("b");
    expect(stepIn([], null, 1)).toBeNull();
  });
});

describe("diff target and unit queue", () => {
  const cp = (over: Partial<Checkpoint>) => ({ source: "turn", base_rev: "abcdef123456", head_rev: "123456abcdef", ...over }) as Checkpoint;

  it("says what a checkpoint is a diff of", () => {
    expect(describeTarget(cp({}))).toBe("Agent turn");
    expect(describeTarget(cp({ source: "manual" }))).toBe("Working changes");
    expect(describeTarget(cp({ source: "compare", base_label: "main (merge base)", head_label: "feature" }))).toBe("main (merge base) \u2192 feature");
    expect(describeTarget(cp({ source: "compare", head_live: false }))).toBe("abcdef1 \u2192 123456a");
    expect(describeTarget(cp({ source: "compare", base_label: "main", head_label: "working tree", head_live: true }))).toBe("main \u2192 working tree");
  });

  it("says what is shown in plain words, with no checkpoint numbers", () => {
    expect(shownLabel(cp({}), "main", "feature/x")).toBe("feature/x against main");
    expect(shownLabel(cp({}), "a1b2c3d", null)).toBe("Working tree against a1b2c3d");
    expect(shownLabel(cp({ source: "turn" }), null, "feature/x")).toBe("Last agent turn");
    expect(shownLabel(cp({ source: "manual" }), null, "feature/x")).toBe("Edits since the last check");
    expect(shownLabel(null, null, null)).toBe("No comparison chosen");
    // A comparison that is no longer chosen is never presented as something else.
    expect(shownLabel(cp({ source: "compare" }), null, "feature/x")).toBe("No comparison chosen");
  });

  it("says why nothing is compared and what to do, whichever way there is no diff", () => {
    // No reference picked, on a branch.
    const onBranch = noDiffMessage(null, null, "feature/x");
    expect(onBranch).toContain("No comparison chosen");
    expect(onBranch).toContain("Pick a branch or a commit in Compare with…");
    expect(onBranch).toContain("feature/x");
    expect(onBranch).toContain("agent");
    // No branch at all (a detached HEAD): say so and point at the header.
    const detached = noDiffMessage(null, null, null);
    expect(detached).toContain("not on a branch");
    expect(detached).toContain("Switch to a branch in the header");
    // A reference that cannot be compared says git's reason, with the reference named.
    expect(noDiffMessage("develop", "there are no differences between develop and working tree", "feature/x")).toBe(
      "Nothing to show against develop: there are no differences between develop and working tree",
    );
    expect(noDiffMessage("develop", null, "feature/x")).toBe("No differences against develop.");
    for (const text of [onBranch, detached]) {
      expect(text).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it("follows the agent's latest turn, never a comparison, and keeps what is on screen when a reload found nothing new", () => {
    const list = [
      { id: "a", source: "turn" },
      { id: "b", source: "manual" },
      { id: "c", source: "compare" },
    ] as const;
    expect(latestOfTurns(list)?.id).toBe("b");
    expect(latestOfTurns([{ id: "c", source: "compare" }])).toBeNull();
    expect(latestOfTurns([])).toBeNull();
    const before = { files: ["a", "b"], n: 1 };
    expect(unchanged(before, { files: ["a", "b"], n: 1 })).toBe(true);
    expect(unchanged(before, { files: ["a"], n: 1 })).toBe(false);
    expect(unchanged(null, null)).toBe(true);
    expect(unchanged(null, before)).toBe(false);
  });

  it("orders units by criticality, then by place in the code", () => {
    const unit = (id: string, path: string, line: number, score: number) => ({ id, path, start_line: line, score }) as Unit;
    const queue = unitQueue({
      units: [unit("a", "b.py", 9, 50), unit("b", "a.py", 20, 50), unit("c", "a.py", 3, 50), unit("d", "z.py", 1, 90)],
    } as unknown as ReviewPriority);
    expect(queue.map((item) => item.id)).toEqual(["d", "c", "b", "a"]);
    expect(unitQueue(null)).toEqual([]);
  });
});
