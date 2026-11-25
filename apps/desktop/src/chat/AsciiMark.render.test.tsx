// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AsciiMark } from "./AsciiMark";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A canvas that only counts what is written on it. */
const context = {
  fillText: vi.fn(),
  clearRect: vi.fn(),
  setTransform: vi.fn(),
  measureText: vi.fn(() => ({ width: 8 })),
  font: "",
  textBaseline: "",
  fillStyle: "",
  globalAlpha: 1,
};

let clock = 0;
let hidden = false;
let nextFrame = 1;
/** The frames the page has asked for and not yet been given. */
const pending = new Map<number, FrameRequestCallback>();
/** The system's choice to reduce motion, and who is listening for it to change. */
const reduced = { matches: false, listeners: new Set<() => void>() };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  clock = 1000;
  hidden = false;
  nextFrame = 1;
  pending.clear();
  reduced.matches = false;
  reduced.listeners.clear();
  context.fillText.mockClear();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      pending.set(nextFrame, callback);
      return nextFrame++;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      pending.delete(id);
    }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return reduced.matches;
    },
    addEventListener: (_type: string, listener: () => void) => reduced.listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => reduced.listeners.delete(listener),
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 320,
    height: 240,
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 320,
    bottom: 240,
    toJSON: () => ({}),
  });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "hidden");
});

function mount(): () => void {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<AsciiMark mark />));
  return () => {
    act(() => root.unmount());
    host.remove();
  };
}

/** Time goes by: the clock the page reads and the timers move together. */
function tick(ms: number, times = 1) {
  for (let i = 0; i < times; i += 1) {
    clock += ms;
    vi.advanceTimersByTime(ms);
  }
}

/** The web view calls for the frame the page asked for. */
function frame() {
  const next = [...pending][0];
  if (!next) {
    return;
  }
  pending.delete(next[0]);
  next[1](clock);
}

function setReduced(on: boolean) {
  reduced.matches = on;
  reduced.listeners.forEach((listener) => listener());
}

const drawn = () => context.fillText.mock.calls.length;
const asked = () => vi.mocked(requestAnimationFrame).mock.calls.length;

it("paints the picture at once, before the web view calls for any frame", () => {
  const unmount = mount();
  expect(drawn()).toBeGreaterThan(0);
  expect(pending.size).toBe(1);
  unmount();
});

it("keeps the picture moving on a timer when the web view never calls for a frame", () => {
  const unmount = mount();
  const first = drawn();

  // About a second in, nothing is wrong yet: only the watch is running.
  tick(34, 30);
  expect(vi.getTimerCount()).toBe(1);
  expect(drawn()).toBe(first);

  // Seconds without a frame while the window is in view: the timer takes over.
  tick(34, 90);
  expect(vi.getTimerCount()).toBe(2);
  expect(drawn()).toBeGreaterThan(first);
  const moving = drawn();
  tick(34, 10);
  expect(drawn()).toBeGreaterThan(moving);
  unmount();
});

it("leaves the timer alone while the web view keeps calling for frames", () => {
  const unmount = mount();
  for (let i = 0; i < 180; i += 1) {
    tick(17);
    frame();
  }
  expect(vi.getTimerCount()).toBe(1);
  expect(drawn()).toBeGreaterThan(0);
  unmount();
});

it("does not count a hidden window as a web view that stopped", () => {
  const unmount = mount();
  hidden = true;
  tick(34, 150);
  expect(vi.getTimerCount()).toBe(1);
  unmount();
});

it("asks for a frame again when the window comes back, and gives frames another try", () => {
  const unmount = mount();
  const before = asked();

  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(asked()).toBe(before);

  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(asked()).toBe(before + 1);
  // The request that may have been lost is replaced, not added to.
  expect(pending.size).toBe(1);

  // A timer that stood in for frames is put away on the wake: frames get their chance again.
  tick(34, 120);
  expect(vi.getTimerCount()).toBe(2);
  window.dispatchEvent(new Event("focus"));
  expect(vi.getTimerCount()).toBe(1);
  unmount();
});

it("follows the choice to reduce motion while the app is open", () => {
  const unmount = mount();
  expect(vi.getTimerCount()).toBe(1);
  const before = drawn();

  setReduced(true);
  expect(pending.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  // What stays is the still picture.
  expect(drawn()).toBeGreaterThan(before);

  setReduced(false);
  expect(pending.size).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  unmount();
});

it("stays a still picture, with no frames or timers, when motion is reduced from the start", () => {
  reduced.matches = true;
  const unmount = mount();
  expect(drawn()).toBeGreaterThan(0);
  expect(pending.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  unmount();
});

it("leaves nothing running when it goes away", () => {
  const unmount = mount();
  tick(34, 120);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(pending.size).toBe(0);
  expect(reduced.listeners.size).toBe(0);

  const before = asked();
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  expect(asked()).toBe(before);
});
