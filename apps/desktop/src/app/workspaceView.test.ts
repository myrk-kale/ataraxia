import { describe, expect, it } from "vitest";
import type { Repository, WorkspaceSnapshot } from "../lib/workspace";
import {
  referenceKey,
  repositoryOptionLabel,
  resolveFileRef,
  selectedWorkspace,
  unreviewedElsewhere,
} from "./workspaceView";

const repo = (id: string, name: string): Repository => ({ id, root: `/w/${name}`, name, created_at: "", updated_at: "" });
const app = repo("r1", "app");
const api = repo("r2", "api");
const web = repo("r3", "web");

describe("resolveFileRef", () => {
  it("leaves a path alone in a workspace of one", () => {
    expect(resolveFileRef("api/routes.rs", "r1", [app])).toEqual({ repositoryId: "r1", path: "api/routes.rs" });
  });

  it("sends <repository>/<path> to that member and bare paths to the chat's own repository", () => {
    const members = [app, api, web];
    expect(resolveFileRef("api/routes/users.rs", "r1", members)).toEqual({ repositoryId: "r2", path: "routes/users.rs" });
    expect(resolveFileRef("src/main.ts", "r1", members)).toEqual({ repositoryId: "r1", path: "src/main.ts" });
  });

  it("never reads the chat's own name as a prefix, nor a bare name with nothing after it", () => {
    const members = [app, api];
    expect(resolveFileRef("app/lib.ts", "r1", members)).toEqual({ repositoryId: "r1", path: "app/lib.ts" });
    expect(resolveFileRef("api/", "r1", members)).toEqual({ repositoryId: "r1", path: "api/" });
    expect(resolveFileRef("api", "r1", members)).toEqual({ repositoryId: "r1", path: "api" });
  });

  it("keeps a null repository when there is no chat", () => {
    expect(resolveFileRef("web/index.html", null, [api, web])).toEqual({ repositoryId: "r3", path: "index.html" });
    expect(resolveFileRef("src/a.ts", null, [api, web])).toEqual({ repositoryId: null, path: "src/a.ts" });
  });
});

describe("selectedWorkspace", () => {
  const snapshot = {
    repositories: [app, api],
    workspaces: [{ id: "w1", name: "acme", repository_ids: ["r2", "gone", "r1"], created_at: "", updated_at: "" }],
    selected_workspace_id: "w1",
  } as unknown as WorkspaceSnapshot;

  it("lists the members in the order of the workspace and skips the ones that no longer exist", () => {
    expect(selectedWorkspace(snapshot)?.members.map((item) => item.name)).toEqual(["api", "app"]);
  });

  it("is null without a selection", () => {
    expect(selectedWorkspace({ ...snapshot, selected_workspace_id: null })).toBeNull();
  });
});

describe("the repository selector", () => {
  it("says in words what the agent changed there", () => {
    expect(repositoryOptionLabel("api", undefined)).toBe("api");
    expect(repositoryOptionLabel("api", { repositoryId: "r2", files: 0, unreviewed: 0 })).toBe("api");
    expect(repositoryOptionLabel("api", { repositoryId: "r2", files: 4, unreviewed: 3 })).toBe("api · 4 changed, 3 unreviewed");
    expect(repositoryOptionLabel("api", { repositoryId: "r2", files: 2, unreviewed: 0 })).toBe("api · 2 changed");
  });

  it("counts the unreviewed files of every repository but the one in focus", () => {
    const changes = [
      { repositoryId: "r1", files: 1, unreviewed: 1 },
      { repositoryId: "r2", files: 4, unreviewed: 3 },
      { repositoryId: "r3", files: 2, unreviewed: 2 },
    ];
    expect(unreviewedElsewhere(changes, "r1")).toBe(5);
    expect(unreviewedElsewhere(changes, null)).toBe(6);
  });

  it("remembers a comparison per chat and repository", () => {
    expect(referenceKey("c1", "r1")).not.toBe(referenceKey("c1", "r2"));
  });
});
