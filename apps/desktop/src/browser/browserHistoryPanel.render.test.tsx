// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserHistoryPanel } from "./BrowserHistoryPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const bridge = vi.hoisted(() => ({ list: vi.fn(), clear: vi.fn(), open: vi.fn() }));
vi.mock("../lib/browser", () => ({ browserHistory: bridge.list, browserClearHistory: bridge.clear, browserOpen: bridge.open }));
let host: HTMLDivElement;
let root: Root;
const close = vi.fn();
const entry = { url: "https://docs.test/", title: "Documentation", visitedAt: "2026-11-26T00:00:00Z", profile: "agent" };
const button = (text: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.includes(text))!;
async function render(workspace = "one") {
  await act(async () => root.render(<BrowserHistoryPanel key={workspace} workspaceId={workspace} onClose={close} />));
}
beforeEach(() => {
  vi.resetAllMocks();
  bridge.list.mockResolvedValue([entry]);
  bridge.clear.mockResolvedValue(undefined);
  bridge.open.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("shows visits, filters by title or URL, and reopens a page in a new tab", async () => {
  await render();
  expect(bridge.list).toHaveBeenCalledWith("one");
  expect(host.querySelector('[aria-label="Visited by an agent"]')).not.toBeNull();
  const input = host.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  function search(text: string) {
    act(() => { setter.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  search("missing");
  expect(host.textContent).toContain("No pages match");
  search("DOCS.TEST");
  expect(host.textContent).toContain("Documentation");
  await act(async () => button("Documentation").click());
  expect(bridge.open).toHaveBeenCalledWith(entry.url);
  expect(close).toHaveBeenCalledOnce();
});

it("requires confirmation to clear only the selected workspace", async () => {
  await render();
  await act(async () => button("Clear history").click());
  expect(bridge.clear).not.toHaveBeenCalled();
  await act(async () => button("Cancel").click());
  expect(bridge.clear).not.toHaveBeenCalled();
  await act(async () => button("Clear history").click());
  await act(async () => button("Confirm clear").click());
  expect(bridge.clear).toHaveBeenCalledWith("one");
  expect(host.textContent).toContain("No pages visited");
});

it("discards late results when switching workspaces", async () => {
  let finish: (items: typeof entry[]) => void = () => undefined;
  bridge.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce([]);
  await render();
  await render("two");
  await act(async () => finish([entry]));
  expect(host.textContent).not.toContain("Documentation");
  expect(host.textContent).toContain("No pages visited");
});

it("shows load failures and lets the user retry", async () => {
  bridge.list.mockRejectedValueOnce(new Error("storage failed"));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("storage failed");
  await act(async () => button("Try again").click());
  expect(host.textContent).toContain("Documentation");
});

it("keeps visits visible when clearing fails", async () => {
  bridge.clear.mockRejectedValueOnce(new Error("storage failed"));
  await render();
  await act(async () => button("Clear history").click());
  await act(async () => button("Confirm clear").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("storage failed");
  expect(host.textContent).toContain("Documentation");
});
