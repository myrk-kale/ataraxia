// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatSession, Workspace, Worktree } from "../lib/workspace";
import { groupByWorkspace, placeLabel, SessionsPanel } from "./SessionsPanel";

function workspace(id: string, name: string): Workspace {
  return { id, name, repository_ids: [], created_at: "t", updated_at: "t" };
}

function chat(id: string, workspaceId: string, title: string, worktree = "w1"): ChatSession {
  return {
    id,
    workspace_id: workspaceId,
    repository_id: "r1",
    worktree_id: worktree,
    provider: "claude",
    title,
    status: "idle",
    model: null,
    effort: null,
    agent: null,
    created_at: "t",
    updated_at: "t",
    last_opened_at: null,
  };
}

const worktree: Worktree = {
  id: "w1",
  repository_id: "r1",
  path: "/work/shop-api",
  branch: "feature/cart",
  head: null,
  created_at: "t",
  updated_at: "t",
};

describe("chats by workspace", () => {
  const workspaces = [workspace("a", "Shop"), workspace("b", "Blog"), workspace("c", "Empty")];

  it("lists the workspace on screen first, then the others that have chats", () => {
    const groups = groupByWorkspace(workspaces, "b", [chat("1", "b", "Fix feed")], [chat("2", "a", "Cart bug")]);
    expect(groups.map((group) => [group.workspace.name, group.current, group.sessions.length])).toEqual([
      ["Blog", true, 1],
      ["Shop", false, 1],
    ]);
  });

  it("keeps the workspace on screen even when it has no chats", () => {
    const groups = groupByWorkspace(workspaces, "c", [], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].workspace.name).toBe("Empty");
  });

  it("names where a chat runs", () => {
    expect(placeLabel(worktree, undefined)).toBe("feature/cart");
    expect(placeLabel(worktree, { r1: "shop-api" })).toBe("shop-api · feature/cart");
    expect(placeLabel(undefined, undefined)).toBeNull();
  });

  it("shows every workspace's chats under its own heading", () => {
    const html = renderToStaticMarkup(
      <SessionsPanel
        currentWorkspaceId="a"
        otherSessions={[chat("2", "b", "Fix feed")]}
        selectedId="1"
        sessions={[chat("1", "a", "Cart bug")]}
        workspaces={workspaces}
        worktrees={[worktree]}
        onClose={() => undefined}
        onDelete={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(html.indexOf("Shop")).toBeLessThan(html.indexOf("Blog"));
    expect(html).toContain("this workspace");
    expect(html).toContain("Cart bug");
    expect(html).toContain("Fix feed");
    expect(html).not.toContain("Empty");
  });
});
