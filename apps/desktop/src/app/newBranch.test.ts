import { describe, expect, it } from "vitest";
import type { GitRefs } from "../lib/insights";
import { baseOptions } from "./NewBranchDialog";

const refs: GitRefs = {
  current: "main",
  refs: [
    { name: "main", kind: "branch", rev: "a", subject: "init" },
    { name: "feat/x", kind: "branch", rev: "b", subject: "x" },
    { name: "origin/feat/y", kind: "remote", rev: "c", subject: "y" },
    { name: "v1.0", kind: "tag", rev: "d", subject: "release" },
  ],
  commits: [{ rev: "a".repeat(40), short: "aaaaaaa", date: "", author: "", subject: "first commit" }],
};

describe("what a new branch can start from", () => {
  it("lists the current branch first, then branches, remotes, tags and commits, once each", () => {
    const options = baseOptions(refs, "main", [], []);
    expect(options.map((option) => option.value)).toEqual(["main", "feat/x", "origin/feat/y", "v1.0", "a".repeat(40)]);
    expect(options[0]?.hint).toBe("current branch");
    expect(options[2]?.hint).toContain("remote");
  });

  it("falls back to the branches the selector knows when no chat can read the refs", () => {
    const options = baseOptions(null, "main", ["main", "dev"], ["origin/dev"]);
    expect(options.map((option) => option.value)).toEqual(["main", "dev", "origin/dev"]);
  });
});
