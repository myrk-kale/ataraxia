import { describe, expect, it } from "vitest";
import { parseBtwReport } from "./btwReport";

const note =
  "[BTW report, for your awareness. This is not a request: answer in one short sentence at most, and do not start new work unless the developer asks.]\nThe developer used BTW, a side conversation that does not appear in this chat, and it finished.\n\n1. Asked (a read-only question): What does this node do?\nIt **sends** a message.\n\nSee [Service](/a/b.ts:3).\n\n2. Asked (a delegated change, which may have edited files in this worktree): Rename it\nDone.\n";

describe("parseBtwReport", () => {
  it("reads each entry and drops the instruction", () => {
    expect(parseBtwReport(note)).toEqual([
      { kind: "a read-only question", asked: "What does this node do?", summary: "It **sends** a message.\n\nSee [Service](/a/b.ts:3)." },
      { kind: "a delegated change, which may have edited files in this worktree", asked: "Rename it", summary: "Done." },
    ]);
  });

  it("leaves what the developer typed alone", () => {
    expect(parseBtwReport("[BTW] hello")).toBeNull();
    expect(parseBtwReport("1. Asked (x): y")).toBeNull();
  });
});
