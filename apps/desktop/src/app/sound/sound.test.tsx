// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../SettingsDialog";
import { normalizeSound, play, setSound, watchForTouch } from "./sound";

vi.mock("../appearance/installedFonts", () => ({ installedFonts: () => [] }));

class TestAudioContext {
  static instances: TestAudioContext[] = [];
  static initialState = "running";

  state = TestAudioContext.initialState;
  currentTime = 0;
  destination = {};
  start = vi.fn();
  close = vi.fn(async () => {
    this.state = "closed";
  });
  resume = vi.fn(async () => {
    this.state = "running";
  });

  constructor() {
    TestAudioContext.instances.push(this);
  }

  createGain() {
    return {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
  }

  createOscillator() {
    return {
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: (gain: ReturnType<TestAudioContext["createGain"]>) => gain,
      start: this.start,
      stop: vi.fn(),
    };
  }
}

describe("sound settings", () => {
  it("are on and quiet by default, and a stored value is made whole and in range", () => {
    expect(normalizeSound(null)).toEqual({ enabled: true, volume: 0.6 });
    expect(normalizeSound({ enabled: false, volume: 3 })).toEqual({ enabled: false, volume: 1 });
    expect(normalizeSound({ enabled: "no", volume: -1 })).toEqual({ enabled: true, volume: 0 });
    expect(normalizeSound({ volume: Number.NaN }).volume).toBe(0.6);
  });
});

describe("sound playback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", TestAudioContext);
    TestAudioContext.initialState = "running";
    TestAudioContext.instances = [];
    setSound({ enabled: true, volume: 0.6 });
    const stopWatching = watchForTouch();
    document.dispatchEvent(new Event("pointerdown"));
    stopWatching();
  });

  afterEach(() => {
    setSound({ enabled: false });
    window.localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("mutes effects when clicking the visible switch track in Settings", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<SettingsDialog isOpen provider={null} onClose={() => {}} />));
      const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((item) => item.textContent === "Sound");
      act(() => tab?.click());
      const track = document.querySelector<HTMLElement>('[data-slot="switch-control"]');
      const input = document.querySelector<HTMLInputElement>('input[role="switch"]');
      expect(input?.checked).toBe(true);
      act(() => {
        for (const type of ["pointerdown", "pointerup", "click"]) {
          track?.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: "mouse",
            pointerId: 1,
            width: 1,
            height: 1,
            detail: 1,
          }));
        }
      });
      expect(input?.checked).toBe(false);
      expect(document.querySelector<HTMLInputElement>('input[aria-label="Sound volume"]')?.disabled).toBe(true);
      expect(JSON.parse(window.localStorage.getItem("ataraxia.sound") ?? "{}")).toMatchObject({ enabled: false });
      play("tick");
      play("alert");
      expect(TestAudioContext.instances).toHaveLength(0);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it.each(["suspended", "interrupted"])("waits for a %s context to resume before playing", async (state) => {
    TestAudioContext.initialState = state;
    play("alert");
    const [ctx] = TestAudioContext.instances;
    expect(ctx.resume).toHaveBeenCalledOnce();
    expect(ctx.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.start).toHaveBeenCalledTimes(2);
    ctx.currentTime = 1;
    await vi.advanceTimersByTimeAsync(300);
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it("recreates a context that reports running while its clock is frozen", async () => {
    play("alert");
    const [frozen] = TestAudioContext.instances;
    await vi.advanceTimersByTimeAsync(300);
    const [, fresh] = TestAudioContext.instances;
    expect(frozen.close).toHaveBeenCalledOnce();
    expect(fresh.start).toHaveBeenCalledTimes(2);
    fresh.currentTime = 1;
    await vi.advanceTimersByTimeAsync(300);
    expect(TestAudioContext.instances).toHaveLength(2);
  });

  it("recreates a context whose resume never settles and ignores the old request if it later resolves", async () => {
    play("alert");
    const [stuck] = TestAudioContext.instances;
    stuck.currentTime = 1;
    await vi.advanceTimersByTimeAsync(300);
    stuck.start.mockClear();
    stuck.state = "suspended";
    let finishResume: () => void = () => {};
    stuck.resume.mockImplementation(() => new Promise<void>((resolve) => {
      finishResume = resolve;
    }));
    play("alert");
    await vi.advanceTimersByTimeAsync(300);
    const [, fresh] = TestAudioContext.instances;
    expect(stuck.close).toHaveBeenCalledOnce();
    expect(fresh.start).toHaveBeenCalledTimes(2);
    finishResume();
    await vi.advanceTimersByTimeAsync(0);
    expect(stuck.start).not.toHaveBeenCalled();
  });

  it("drops a cue waiting for resume when sounds are disabled", async () => {
    TestAudioContext.initialState = "interrupted";
    play("alert");
    const [ctx] = TestAudioContext.instances;
    setSound({ enabled: false });
    setSound({ enabled: true });
    await vi.advanceTimersByTimeAsync(600);
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(ctx.start).not.toHaveBeenCalled();
    expect(TestAudioContext.instances).toHaveLength(1);
  });
});
