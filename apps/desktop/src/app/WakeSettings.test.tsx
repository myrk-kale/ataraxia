// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WakePanel } from "./WakeSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("shows the saved mode and saves the one chosen", async () => {
  invoke.mockImplementation((command: string, args?: { mode: string }) => {
    if (command === "wake_mode") return Promise.resolve("system");
    if (command === "wake_set_mode") return Promise.resolve(args?.mode);
    throw new Error(`Unexpected command ${command}`);
  });
  HTMLElement.prototype.showPopover ??= function () {};
  HTMLElement.prototype.hidePopover ??= function () {};
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<WakePanel />));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
    expect(trigger?.textContent).toContain("Computer only");
    act(() => trigger?.click());
    const option = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((item) =>
      item.textContent?.includes("Computer and screen"),
    );
    expect(option).toBeDefined();
    await act(async () => option?.click());
    expect(invoke).toHaveBeenCalledWith("wake_set_mode", { mode: "display" });
    expect(trigger?.textContent).toContain("Computer and screen");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
