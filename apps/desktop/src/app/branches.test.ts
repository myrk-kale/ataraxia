import { describe, expect, it } from "vitest";
import type { GitRefs } from "../lib/insights";
import { filterOptions } from "../ui/QuietSelect";
import { referenceOptions } from "./ReferenceSelect";

const refs: GitRefs = {
  current: "feature/x",
  refs: [
    { name: "feature/x", kind: "branch", rev: "1", subject: "work" },
    { name: "main", kind: "branch", rev: "2", subject: "merge" },
    { name: "fix/node-24-cve-2025-55130", kind: "branch", rev: "3", subject: "bump" },
    { name: "origin/main", kind: "remote", rev: "2", subject: "merge" },
    { name: "v2.3.0", kind: "tag", rev: "4", subject: "release" },
  ],
  commits: [{ rev: "abcdef1234567", short: "abcdef1", subject: "Fix retry backoff", date: "", author: "Ana" }],
};

describe("what the current branch can be compared with", () => {
  it("offers no comparison first, then every other branch, remote, tag and recent commit", () => {
    const options = referenceOptions(refs, "feature/x", "");
    expect(options[0]).toMatchObject({ value: "", display: "Compare with…" });
    expect(options.map((o) => o.value)).toEqual(["", "main", "fix/node-24-cve-2025-55130", "origin/main", "v2.3.0", "abcdef1234567"]);
  });

  it("never offers the branch you are on, and shows a chosen one even when it is gone from the list", () => {
    expect(referenceOptions(refs, "feature/x", "").some((o) => o.value === "feature/x")).toBe(false);
    const kept = referenceOptions(refs, "feature/x", "deleted-branch");
    expect(kept[1]).toMatchObject({ value: "deleted-branch", display: "vs deleted-branch" });
    expect(referenceOptions(null, "main", "")).toHaveLength(1);
  });

  it("is searchable by any part of a branch name, a commit message or its short id", () => {
    const options = referenceOptions(refs, "feature/x", "");
    expect(filterOptions(options, "cve").map((o) => o.value)).toEqual(["fix/node-24-cve-2025-55130"]);
    expect(filterOptions(options, "node 24").map((o) => o.value)).toEqual(["fix/node-24-cve-2025-55130"]);
    expect(filterOptions(options, "backoff").map((o) => o.value)).toEqual(["abcdef1234567"]);
    expect(filterOptions(options, "abcdef1").map((o) => o.value)).toEqual(["abcdef1234567"]);
    expect(filterOptions(options, "origin").map((o) => o.value)).toEqual(["origin/main"]);
  });
});
