import { describe, expect, it } from "vitest";
import { findCites, parseCite, resolveCite, resolveFile, type FileIndex } from "./fileRefs";

const index: FileIndex = {
  files: new Set([
    "src/app/main.ts",
    "src/lib/util.ts",
    "tests/util.ts",
    "README.md",
    "Makefile",
    "api/src/server.rs",
    "api/Cargo.toml",
  ]),
  ownRoot: "/work/app",
  others: [{ name: "api", root: "/work/api" }],
};

describe("citing a file with its lines", () => {
  it("reads every form of line suffix", () => {
    expect(parseCite("src/a.ts")).toEqual({ path: "src/a.ts", line: null, endLine: null });
    expect(parseCite("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12, endLine: null });
    expect(parseCite("src/a.ts:12-20")).toEqual({ path: "src/a.ts", line: 12, endLine: 20 });
    expect(parseCite("src/a.ts:12:5")).toEqual({ path: "src/a.ts", line: 12, endLine: null });
    expect(parseCite("src/a.ts#L12")).toEqual({ path: "src/a.ts", line: 12, endLine: null });
    expect(parseCite("src/a.ts#L12-L20")).toEqual({ path: "src/a.ts", line: 12, endLine: 20 });
    expect(parseCite("src/a.ts#L12C3-L20C9")).toEqual({ path: "src/a.ts", line: 12, endLine: 20 });
    expect(parseCite("src/a.ts:20-12")).toEqual({ path: "src/a.ts", line: 20, endLine: 20 });
  });
});

describe("which file a cited path is", () => {
  it("knows relative paths, absolute paths and other repositories", () => {
    expect(resolveFile(index, "src/app/main.ts")).toBe("src/app/main.ts");
    expect(resolveFile(index, "./src/app/main.ts")).toBe("src/app/main.ts");
    expect(resolveFile(index, "/work/app/src/app/main.ts")).toBe("src/app/main.ts");
    expect(resolveFile(index, "/work/api/src/server.rs")).toBe("api/src/server.rs");
    expect(resolveFile(index, "api/src/server.rs")).toBe("api/src/server.rs");
    expect(resolveFile(index, "file:///work/app/README.md")).toBe("README.md");
  });

  it("takes a bare name only when one file has it", () => {
    expect(resolveFile(index, "main.ts")).toBe("src/app/main.ts");
    expect(resolveFile(index, "util.ts")).toBeNull();
    expect(resolveFile(index, "Makefile")).toBe("Makefile");
    expect(resolveFile(index, "lib/util.ts")).toBe("src/lib/util.ts");
  });

  it("refuses what is not a file of this chat", () => {
    expect(resolveFile(index, "src/app/gone.ts")).toBeNull();
    expect(resolveFile(index, "/etc/passwd")).toBeNull();
    expect(resolveFile(index, "/work/other/x.ts")).toBeNull();
    expect(resolveFile(index, "Node.js")).toBeNull();
    expect(resolveFile(index, "")).toBeNull();
  });

  it("returns the lines with the file", () => {
    expect(resolveCite(index, "/work/app/src/app/main.ts:42-50")).toEqual({ path: "src/app/main.ts", line: 42, endLine: 50 });
    expect(resolveCite(index, "nope.ts:3")).toBeNull();
  });
});

describe("finding files in running text", () => {
  const cites = (text: string) => findCites(text).map((item) => item.text);

  it("finds paths with lines and leaves the full stop of a sentence out", () => {
    expect(cites("See src/app/main.ts:42-50, and README.md.")).toEqual(["src/app/main.ts:42-50", "README.md"]);
    expect(cites("in `util.ts#L3` it")).toEqual(["util.ts#L3"]);
    expect(cites("(api/src/server.rs)")).toEqual(["api/src/server.rs"]);
    expect(cites("at /work/app/src/app/main.ts:7")).toEqual(["/work/app/src/app/main.ts:7"]);
  });

  it("does not take URLs, and what it takes but no file answers to is dropped when resolving", () => {
    expect(cites("open https://example.com/x/y.html now")).toEqual([]);
    expect(cites("see http://localhost:3000/app.js")).toEqual([]);
    // Looks like a path, is no file of the chat: the link is only made for what resolves.
    expect(cites("version 1.2.3")).toEqual(["1.2.3"]);
    expect(resolveFile(index, "1.2.3")).toBeNull();
  });
});
