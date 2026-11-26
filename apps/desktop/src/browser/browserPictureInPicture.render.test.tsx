// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBrowserForTests, startBrowser, type AgentActivity, type BrowserTab } from "../lib/browser";
import { BrowserPictureInPicture } from "./BrowserPictureInPicture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const bridge = vi.hoisted(() => ({
  screenshot: vi.fn<(id: number) => Promise<string>>(),
  agentEvent: undefined as ((event: { payload: (AgentActivity & { type: "agent" }) | { type: "tabs"; tabs: BrowserTab[]; active: number | null } }) => void) | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { id: number }) => {
    if (cmd === "browser_screenshot") return bridge.screenshot(args!.id);
    if (cmd === "browser_state") return Promise.reject(new Error("test owns the state"));
    return Promise.resolve();
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, callback: NonNullable<typeof bridge.agentEvent>) => {
    bridge.agentEvent = callback;
    return Promise.resolve(() => undefined);
  },
}));

function tab(id: number): BrowserTab {
  return { id, url: `https://site${id}.test`, title: `Site ${id}`, loading: false, canGoBack: false, canGoForward: false, favicon: null, profile: "agent", agentControl: true, errors: 0, failedRequests: 0, loadError: null };
}

let host: HTMLDivElement;
let root: Root;
const watch = vi.fn();
beforeAll(() => startBrowser());
beforeEach(() => {
  vi.useFakeTimers();
  watch.mockClear();
  bridge.screenshot.mockReset().mockResolvedValue("frame-one");
  resetBrowserForTests({ tabs: [tab(1)], active: 1, agentsAllowed: true }, { tab: 1, busy: true, action: "click" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  resetBrowserForTests();
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function render(): Promise<void> {
  await act(async () => root.render(<BrowserPictureInPicture onWatch={watch} />));
}
async function event(id: number, busy: boolean): Promise<void> {
  await act(async () => bridge.agentEvent?.({ payload: { type: "agent", tab: id, busy, action: "click" } }));
}
async function tabs(items: BrowserTab[], active = items.at(-1)?.id ?? null): Promise<void> {
  await act(async () => bridge.agentEvent?.({ payload: { type: "tabs", tabs: items, active } }));
}

describe("the browser picture in picture", () => {
  it("shows real frames from the agent's tab and opens that tab on click", async () => {
    await render();
    expect(bridge.screenshot).toHaveBeenCalledWith(1);
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,frame-one");
    bridge.screenshot.mockResolvedValue("frame-two");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,frame-two");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Open browser: Site 1"]')!.click());
    expect(watch).toHaveBeenCalledWith(1);
  });

  it("never queues captures while one is pending and ignores its result after a tab switch", async () => {
    let finish: (png: string) => void = () => undefined;
    bridge.screenshot.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(bridge.screenshot).toHaveBeenCalledTimes(1);
    await tabs([tab(1), tab(2)]);
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,frame-one");
    await act(async () => finish("old-tab-frame"));
    expect(host.querySelector("img")?.getAttribute("src")).not.toContain("old-tab-frame");
    expect(bridge.screenshot).toHaveBeenLastCalledWith(2);
  });

  it("appears on tab creation and stays visible without tool activity", async () => {
    resetBrowserForTests();
    await render();
    expect(host.querySelector("aside")).toBeNull();
    await tabs([tab(1)]);
    expect(host.querySelector("img")).not.toBeNull();
    await event(1, true);
    await event(1, false);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(host.querySelector("aside")).not.toBeNull();
    await tabs([]);
    expect(host.querySelector("aside")).toBeNull();
    const count = bridge.screenshot.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(bridge.screenshot).toHaveBeenCalledTimes(count);
  });

  it("follows the latest agent tab even when an older tab is used or activated", async () => {
    await render();
    await tabs([tab(1), tab(2)]);
    await event(1, true);
    await tabs([tab(1), tab(2), { ...tab(3), profile: "user" }], 1);
    expect(bridge.screenshot).toHaveBeenLastCalledWith(2);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Open full browser"]')!.click());
    expect(watch).toHaveBeenLastCalledWith(2);
    await tabs([tab(1)]);
    expect(bridge.screenshot).toHaveBeenLastCalledWith(1);
  });

  it("keeps a dismissed tab hidden across activity and remounts, but shows new tabs", async () => {
    await render();
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss browser preview"]')!.click());
    await event(1, false);
    await event(1, true);
    await tabs([tab(1)]);
    await act(async () => root.render(null));
    await render();
    expect(host.querySelector("aside")).toBeNull();
    await tabs([tab(1), tab(2)]);
    expect(host.querySelector("aside")).not.toBeNull();
    await tabs([tab(1)]);
    expect(host.querySelector("aside")).toBeNull();
  });

  it("reports a failed capture and recovers on the next frame", async () => {
    bridge.screenshot.mockRejectedValueOnce(new Error("snapshot failed"));
    await render();
    expect(host.textContent).toContain("Preview unavailable");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(host.textContent).not.toContain("Preview unavailable");
    expect(host.querySelector("img")).not.toBeNull();
  });

  it("pauses captures while the app is hidden and resumes when visible", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await render();
    expect(bridge.screenshot).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(host.querySelector("img")).not.toBeNull();
    hidden.mockReturnValue(true);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(2000); });
    expect(bridge.screenshot).toHaveBeenCalledTimes(1);
  });

  it("keeps the preview while tabs exist even if agent access is revoked", async () => {
    await render();
    await tabs([{ ...tab(1), agentControl: false }]);
    expect(host.querySelector("aside")).not.toBeNull();
    await tabs([]);
    expect(host.querySelector("aside")).toBeNull();
  });

  it("moves with a captured pointer and keyboard, within the chat bounds", async () => {
    await render();
    const panel = host.querySelector("aside")!;
    Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
    Object.defineProperties(panel, { offsetWidth: { value: 288 }, offsetHeight: { value: 199 } });
    const handle = host.querySelector<HTMLButtonElement>('button[aria-label="Move browser preview"]')!;
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);
    handle.releasePointerCapture = vi.fn();
    function pointer(type: string, x: number, y: number): void {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, "pointerId", { value: 7 });
      act(() => handle.dispatchEvent(event));
    }
    pointer("pointerdown", 600, 400);
    pointer("pointermove", 400, 300);
    expect(panel.style.right).toBe("216px");
    expect(panel.style.bottom).toBe("116px");
    pointer("pointerup", 400, 300);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);
    pointer("pointermove", 200, 100);
    expect(panel.style.right).toBe("216px");
    act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(panel.style.right).toBe("226px");
    pointer("pointerdown", 400, 300);
    pointer("pointermove", -1000, -1000);
    expect(panel.style.right).toBe("512px");
    expect(panel.style.bottom).toBe("401px");
    pointer("pointercancel", -1000, -1000);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Open browser: Site 1"]')!.click());
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("clamps its position when the chat resizes", async () => {
    let resized: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect = disconnect;
    });
    await render();
    const panel = host.querySelector("aside")!;
    Object.defineProperties(host, { clientWidth: { value: 300 }, clientHeight: { value: 200 } });
    Object.defineProperties(panel, { offsetWidth: { value: 288 }, offsetHeight: { value: 199 } });
    act(() => resized?.());
    expect(panel.style.right).toBe("12px");
    expect(panel.style.bottom).toBe("1px");
    await act(async () => root.render(null));
    expect(disconnect).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
