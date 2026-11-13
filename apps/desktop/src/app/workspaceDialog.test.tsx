// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository, Workspace, WorkspaceSnapshot } from "../lib/workspace";
import { WorkspaceDialog } from "./WorkspaceDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  register: vi.fn(),
  pick: vi.fn(),
}));

vi.mock("../lib/workspace", () => ({
  workspaceCreateWorkspace: api.create,
  workspaceUpdateWorkspace: api.update,
  workspaceDeleteWorkspace: api.remove,
  workspaceRegisterRepository: api.register,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: api.pick }));
// The real dialog is a portal with focus handling that jsdom does not need to prove here.
vi.mock("../ui/Overlay", () => ({
  Dialog: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => (isOpen ? <div role="dialog">{children}</div> : null),
}));

const repo = (id: string, name: string): Repository => ({ id, root: `/w/${name}`, name, created_at: "", updated_at: "" });
const known = [repo("r1", "app"), repo("r2", "api"), repo("r3", "web")];
const snapshot = { workspaces: [] } as unknown as WorkspaceSnapshot;

let root: Root;
let host: HTMLDivElement;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function show(workspace: Workspace | null, handlers: { onClose?: () => void; onSaved?: (s: WorkspaceSnapshot) => void } = {}) {
  act(() => {
    root.render(
      <WorkspaceDialog
        isOpen
        repositories={known}
        workspace={workspace}
        onClose={handlers.onClose ?? (() => undefined)}
        onSaved={handlers.onSaved ?? (() => undefined)}
      />,
    );
  });
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function check(label: string) {
  const box = [...host.querySelectorAll("label")].find((item) => item.textContent?.includes(label))!.querySelector("input")!;
  act(() => box.click());
}

const submit = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const buttonNamed = (text: string) => [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("WorkspaceDialog", () => {
  it("needs a name and at least one repository before it can create anything", () => {
    show(null);
    expect(submit().disabled).toBe(true);
    type(host.querySelector("input")!, "acme");
    expect(submit().disabled).toBe(true);
    check("api");
    expect(submit().disabled).toBe(false);
    expect(buttonNamed("Delete workspace")).toBeUndefined();
  });

  it("creates the workspace with the members in the order they were ticked, then closes", async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    api.create.mockResolvedValue(snapshot);
    show(null, { onClose, onSaved });
    type(host.querySelector("input")!, "  acme ");
    check("web");
    check("app");
    act(() => submit().click());
    await flush();
    expect(api.create).toHaveBeenCalledWith("  acme ", ["r3", "r1"]);
    expect(onSaved).toHaveBeenCalledWith(snapshot);
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the dialog open and says why when the workspace is refused", async () => {
    const onClose = vi.fn();
    api.create.mockRejectedValue(new Error("a workspace named `acme` already exists"));
    show(null, { onClose });
    type(host.querySelector("input")!, "acme");
    check("api");
    act(() => submit().click());
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("already exists");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("edits a workspace: starts from its members, saves, and can delete it", async () => {
    const workspace: Workspace = { id: "w1", name: "acme", repository_ids: ["r1", "r2"], created_at: "", updated_at: "" };
    api.update.mockResolvedValue(snapshot);
    show(workspace);
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("acme");
    check("api");
    act(() => submit().click());
    await flush();
    expect(api.update).toHaveBeenCalledWith("w1", "acme", ["r1"]);

    api.remove.mockRejectedValue(new Error("this workspace still has 2 chats: delete them first"));
    show(workspace);
    act(() => buttonNamed("Delete workspace")!.click());
    await flush();
    expect(api.remove).toHaveBeenCalledWith("w1");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("2 chats");
  });

  it("adds a folder as a known repository and ticks it", async () => {
    api.pick.mockResolvedValue("/w/infra");
    api.register.mockResolvedValue(repo("r9", "infra"));
    api.create.mockResolvedValue(snapshot);
    show(null);
    type(host.querySelector("input")!, "ops");
    act(() => buttonNamed("Add folder…")!.click());
    await flush();
    expect(api.register).toHaveBeenCalledWith("/w/infra");
    expect(host.textContent).toContain("infra");
    act(() => submit().click());
    await flush();
    expect(api.create).toHaveBeenCalledWith("ops", ["r9"]);
  });
});
