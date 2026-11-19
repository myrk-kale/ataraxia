// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ResourceList } from "../lib/resources";
import { ResourcesSettings } from "./ResourcesSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("signs in to a remote MCP from Settings and shows the shared authorization", async () => {
  const list: ResourceList = {
    skills: [],
    mcps: [{
      id: "Notion",
      kind: "mcp",
      description: "https://mcp.notion.com/mcp",
      definedIn: "global",
      state: "on",
      effective: true,
      inherited: true,
      inheritedFrom: null,
      mcpAuth: "signIn",
    }],
    problems: [],
  };
  let finishLogin: () => void = () => {};
  const login = new Promise<void>((resolve) => { finishLogin = resolve; });
  invoke.mockImplementation((command: string) => {
    if (command === "resources_list") return Promise.resolve(list);
    if (command === "resources_sign_in_mcp") return login;
    throw new Error(`Unexpected command ${command}`);
  });

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  try {
    await act(async () => root.render(<ResourcesSettings workspace={null} repository={null} />));
    const mcpTab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((tab) => tab.textContent === "MCP servers");
    expect(mcpTab).toBeDefined();
    act(() => {
      mcpTab?.click();
    });
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Sign in to Notion"]');
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(invoke).toHaveBeenCalledWith("resources_sign_in_mcp", {
      context: { scope: "global", workspaceId: null, repositoryId: null },
      name: "Notion",
    });
    expect(button?.disabled).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Complete sign-in in your browser");
    await act(async () => finishLogin());
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Authorized for new sessions");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Sign in again to Notion"]')?.disabled).toBe(false);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    if (animations) Object.defineProperty(Element.prototype, "getAnimations", animations);
    else Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
});
