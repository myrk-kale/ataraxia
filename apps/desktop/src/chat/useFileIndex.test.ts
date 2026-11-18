import { describe, expect, it } from "vitest";
import { fileIndexFrom } from "./useFileIndex";

describe("the files a chat can name", () => {
  it("keeps the chat's own files bare and names the others after their repository", () => {
    const index = fileIndexFrom(
      [
        { path: "src/", dir: true, repository: null },
        { path: "src/a.ts", dir: false, repository: null },
        { path: "/work/api/", dir: true, repository: "api" },
        { path: "/work/api/src/", dir: true, repository: "api" },
        { path: "/work/api/src/server.rs", dir: false, repository: "api" },
      ],
      "/work/app",
    );
    expect([...index.files].sort()).toEqual(["api/src/server.rs", "src/a.ts"]);
    expect(index.ownRoot).toBe("/work/app");
    expect(index.others).toEqual([{ name: "api", root: "/work/api" }]);
  });
});
