// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { progressPercent, UPDATE_FIRST_CHECK_MS, UPDATE_RECHECK_MS } from "../lib/update";
import { UpdatePrompt } from "./UpdatePrompt";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoke = vi.hoisted(() => vi.fn());
const progressHandlers = vi.hoisted(() => [] as Array<(event: { payload: unknown }) => void>);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (event: { payload: unknown }) => void) => {
    progressHandlers.push(handler);
    return Promise.resolve(() => {});
  },
}));

const FOUND = { version: "0.20.0", current: "0.19.0", notes: "### Added\n\n- Something new." };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  progressHandlers.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

async function mount() {
  await act(async () => root.render(<UpdatePrompt />));
}

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function button(name: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(name));
}

it("says nothing until the first look, and nothing when there is nothing new", async () => {
  invoke.mockResolvedValue(null);
  await mount();
  expect(invoke).not.toHaveBeenCalled();
  await pass(UPDATE_FIRST_CHECK_MS);
  expect(invoke).toHaveBeenCalledWith("update_check");
  expect(host.textContent).toBe("");
});

it("offers the release it finds, with what is new", async () => {
  invoke.mockResolvedValue(FOUND);
  await mount();
  await pass(UPDATE_FIRST_CHECK_MS);
  expect(host.textContent).toContain("Ataraxia 0.20.0 is available");
  expect(host.textContent).toContain("You have 0.19.0");
  expect(host.textContent).toContain("Something new.");
  expect(button("Update and restart")).toBeDefined();
});

it("stays quiet when the look fails, and looks again later", async () => {
  invoke.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(FOUND);
  await mount();
  await pass(UPDATE_FIRST_CHECK_MS);
  expect(host.textContent).toBe("");
  await pass(UPDATE_RECHECK_MS);
  expect(host.textContent).toContain("0.20.0");
});

it("Later hides that version until the app is opened again", async () => {
  invoke.mockResolvedValue(FOUND);
  await mount();
  await pass(UPDATE_FIRST_CHECK_MS);
  await act(async () => button("Later")?.click());
  expect(host.textContent).toBe("");
  await pass(UPDATE_RECHECK_MS);
  expect(host.textContent).toBe("");
});

it("installs on request and shows the download as it goes", async () => {
  invoke.mockImplementation((command: string) =>
    command === "update_check" ? Promise.resolve(FOUND) : new Promise(() => {}),
  );
  await mount();
  await pass(UPDATE_FIRST_CHECK_MS);
  await act(async () => button("Update and restart")?.click());
  expect(invoke).toHaveBeenCalledWith("update_install");
  expect(host.querySelector("progress")).not.toBeNull();
  expect(button("Later")).toBeUndefined();
  await act(async () => progressHandlers.forEach((handler) => handler({ payload: { downloaded: 25, total: 100 } })));
  expect(host.textContent).toContain("25%");
});

it("does not look again while an install is under way", async () => {
  invoke.mockImplementation((command: string) =>
    command === "update_check" ? Promise.resolve(FOUND) : new Promise(() => {}),
  );
  await mount();
  await pass(UPDATE_FIRST_CHECK_MS);
  await act(async () => button("Update and restart")?.click());
  invoke.mockClear();
  await pass(UPDATE_RECHECK_MS);
  expect(invoke).not.toHaveBeenCalledWith("update_check");
});

it("says why an install failed and can be tried again", async () => {
  invoke.mockImplementation((command: string) =>
    command === "update_check" ? Promise.resolve(FOUND) : Promise.reject("signature mismatch"),
  );
  await mount();
  await pass(UPDATE_FIRST_CHECK_MS);
  await act(async () => button("Update and restart")?.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("signature mismatch");
  expect(button("Try again")).toBeDefined();
  invoke.mockClear();
  await act(async () => button("Try again")?.click());
  expect(invoke).toHaveBeenCalledWith("update_install");
});

it("reads the download as a whole percent, or nothing when the size is unknown", () => {
  expect(progressPercent({ downloaded: 1, total: 3 })).toBe(33);
  expect(progressPercent({ downloaded: 5, total: 3 })).toBe(100);
  expect(progressPercent({ downloaded: 5, total: null })).toBeNull();
  expect(progressPercent({ downloaded: 5, total: 0 })).toBeNull();
});
