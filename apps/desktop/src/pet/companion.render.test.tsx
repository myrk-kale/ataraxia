// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionId } from "../lib/workspace";
import { Companion } from "./Companion";
import { STORAGE_KEY, placement, sizeOf, DEFAULT_PET } from "./config";
import { forgetPetForTests, togglePet, updatePet } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let emit: (event: Record<string, unknown>) => void = () => undefined;
vi.mock("../lib/agent", () => ({
  listenAgentEvents: (handler: (event: Record<string, unknown>) => void) => {
    emit = handler;
    return Promise.resolve(() => undefined);
  },
}));

const A = "chat-a" as SessionId;
const B = "chat-b" as SessionId;
const chats = [{ id: A, title: "Refactor uploads" }, { id: B, title: "Fix the login" }];
let host: HTMLDivElement;
let root: Root;
const opened: string[] = [];
let customized = 0;

const pet = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Ata."]')!;
const state = () => host.querySelector(".pet")?.getAttribute("data-state");
const stored = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
const item = (text: string) => [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent?.includes(text))!;

function pointer(target: Element, type: string, x: number, y: number) {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  });
}

async function show(props: { viewing?: SessionId | null } = {}) {
  await act(async () => {
    root.render(<Companion chats={chats} viewing={props.viewing ?? null} onCustomize={() => customized++} onOpenChat={(id) => opened.push(id)} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function say(event: Record<string, unknown>) {
  await act(async () => {
    emit(event);
    await Promise.resolve();
  });
}

beforeEach(() => {
  window.localStorage.clear();
  // It starts off for a new person; these tests are about it being on screen.
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "pet" }));
  forgetPetForTests();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
  opened.length = 0;
  customized = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the companion on screen", () => {
  it("starts resting in the bottom right corner", async () => {
    await show();
    expect(state()).toBe("idle");
    const box = host.firstElementChild as HTMLElement;
    const where = placement(null, { width: 1000, height: 700 }, sizeOf(DEFAULT_PET));
    expect(box.style.left).toBe(`${where.left}px`);
    expect(box.style.top).toBe(`${where.top}px`);
    expect(pet().getAttribute("aria-label")).toContain("Drag to move");
  });

  it("is off until the person turns it on", async () => {
    window.localStorage.clear();
    forgetPetForTests();
    await show();
    expect(host.querySelector(".pet")).toBeNull();
  });

  it("is not there when it is off, and comes back with /pet", async () => {
    updatePet({ mode: "off" });
    await show();
    expect(host.querySelector(".pet")).toBeNull();
    expect(host.textContent).toBe("");
    await act(async () => {
      expect(togglePet()).toBe("pet");
    });
    expect(host.querySelector(".pet")).not.toBeNull();
    await act(async () => {
      expect(togglePet()).toBe("off");
    });
    expect(host.querySelector(".pet")).toBeNull();
  });

  it("is dragged where the pointer takes it and stays there", async () => {
    await show();
    const button = pet();
    const box = host.firstElementChild as HTMLElement;
    const startLeft = parseFloat(box.style.left);
    pointer(button, "pointerdown", 900, 600);
    pointer(button, "pointermove", 900, 600);
    pointer(button, "pointermove", 600, 300);
    expect(parseFloat(box.style.left)).toBeLessThan(startLeft - 200);
    pointer(button, "pointerup", 600, 300);
    const saved = stored().position;
    expect(saved.x).toBeLessThan(0.8);
    expect(saved.y).toBeLessThan(0.7);
    // A drag is not a click: no menu.
    act(() => button.click());
    expect(host.querySelector('[role="menu"]')).toBeNull();
    // After a restart it is where it was left.
    forgetPetForTests();
    await show();
    expect(parseFloat((host.firstElementChild as HTMLElement).style.left)).toBeCloseTo(parseFloat(box.style.left), 3);
  });

  it("cannot be dragged out of the window", async () => {
    await show();
    const button = pet();
    pointer(button, "pointerdown", 900, 600);
    pointer(button, "pointermove", -9000, -9000);
    pointer(button, "pointerup", -9000, -9000);
    expect(stored().position).toEqual({ x: 0, y: 0 });
    pointer(button, "pointerdown", 20, 20);
    pointer(button, "pointermove", 99999, 99999);
    pointer(button, "pointerup", 99999, 99999);
    expect(stored().position).toEqual({ x: 1, y: 1 });
  });

  it("opens its menu on a click, with what can be done", async () => {
    await show();
    pointer(pet(), "pointerdown", 900, 600);
    pointer(pet(), "pointerup", 900, 600);
    act(() => pet().click());
    expect(host.querySelector('[role="menu"]')).not.toBeNull();
    expect(item("Customize")).toBeDefined();
    await act(async () => item("Customize").click());
    expect(customized).toBe(1);
    expect(host.querySelector('[role="menu"]')).toBeNull();
    act(() => pet().click());
    await act(async () => item("Mini").click());
    expect(stored().mode).toBe("mini");
  });

  it("is hidden from its menu, with the way back said", async () => {
    await show();
    act(() => pet().click());
    expect(item("Hide").textContent).toContain("/pet");
    await act(async () => item("Hide").click());
    expect(stored().mode).toBe("off");
    expect(host.querySelector(".pet")).toBeNull();
  });

  it("goes back to its corner from the menu", async () => {
    updatePet({ position: { x: 0.2, y: 0.2 } });
    await show();
    act(() => pet().click());
    await act(async () => item("Back to its corner").click());
    expect(stored().position).toBeNull();
  });

  it("moves with the arrow keys, further with Shift, and returns with Escape", async () => {
    await show();
    const key = (name: string, shift = false) => act(() => void pet().dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey: shift, bubbles: true, cancelable: true })));
    const left = () => parseFloat((host.firstElementChild as HTMLElement).style.left);
    const start = left();
    key("ArrowLeft");
    expect(start - left()).toBeCloseTo(12, 3);
    key("ArrowLeft", true);
    expect(start - left()).toBeCloseTo(60, 3);
    key("Escape");
    expect(stored().position).toBeNull();
    expect(left()).toBeCloseTo(start, 3);
  });
});

describe("what it says about the agents", () => {
  it("shows working, then asks for you, then says it is done, and opens that chat when pressed", async () => {
    await show();
    await say({ type: "status", sessionId: A, status: "working" });
    expect(state()).toBe("running");
    expect(host.textContent).toContain("Working: Refactor uploads");
    await say({ type: "permission", sessionId: A });
    expect(state()).toBe("needs-input");
    expect(host.textContent).toContain("Needs you: Refactor uploads");
    await say({ type: "turnDone", sessionId: A, ok: true });
    await say({ type: "status", sessionId: A, status: "ready" });
    expect(state()).toBe("ready");
    const bubble = [...host.querySelectorAll("button")].find((node) => node.textContent?.includes("Done: Refactor uploads"))!;
    await act(async () => bubble.click());
    expect(opened).toEqual([A]);
    expect(state()).toBe("idle");
  });

  it("shows an error, and the most pressing of several chats", async () => {
    await show();
    await say({ type: "status", sessionId: A, status: "working" });
    await say({ type: "error", sessionId: B, message: "boom" });
    expect(state()).toBe("blocked");
    expect(host.textContent).toContain("Stopped with an error: Fix the login");
    await say({ type: "permission", sessionId: A });
    expect(state()).toBe("needs-input");
  });

  it("does not call a chat unread while the person is looking at it", async () => {
    await show({ viewing: A });
    await say({ type: "status", sessionId: A, status: "working" });
    await say({ type: "turnDone", sessionId: A, ok: true });
    await say({ type: "status", sessionId: A, status: "ready" });
    expect(state()).toBe("idle");
    await say({ type: "turnDone", sessionId: B, ok: true });
    expect(state()).toBe("ready");
    // Opening it is looking at it.
    await show({ viewing: B });
    expect(state()).toBe("idle");
  });

  it("ignores sessions that are not the person's chats and events that are not about a chat", async () => {
    await show();
    await say({ type: "status", sessionId: "helper" as SessionId, status: "working" });
    await say({ type: "usage", usage: {} });
    expect(state()).toBe("idle");
  });

  it("is only the status in mini mode, and can still be moved and opened", async () => {
    updatePet({ mode: "mini" });
    await show();
    expect(host.querySelector(".pet")).toBeNull();
    expect(host.textContent).toContain("All quiet");
    await say({ type: "permission", sessionId: B });
    expect(host.textContent).toContain("Needs you: Fix the login");
    const button = host.querySelector<HTMLButtonElement>("button")!;
    pointer(button, "pointerdown", 900, 600);
    pointer(button, "pointermove", 500, 300);
    pointer(button, "pointerup", 500, 300);
    expect(stored().position).not.toBeNull();
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
    act(() => button.click());
    expect(item("Show the pet")).toBeDefined();
  });
});
