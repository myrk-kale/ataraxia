import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncScheduler } from "./sync";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the reload that follows changes to the files", () => {
  it("turns a burst of changes into one reload after things go quiet", () => {
    const run = vi.fn();
    const scheduler = createSyncScheduler({ run, canRun: () => true, quietMs: 600, maxWaitMs: 4000 });
    scheduler.request();
    vi.advanceTimersByTime(300);
    scheduler.request();
    vi.advanceTimersByTime(500);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(run).toHaveBeenCalledTimes(1);
    // Nothing is left over: quiet means quiet.
    vi.advanceTimersByTime(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("still reloads now and then while changes never stop", () => {
    const run = vi.fn();
    const scheduler = createSyncScheduler({ run, canRun: () => true, quietMs: 600, maxWaitMs: 2000 });
    for (let elapsed = 0; elapsed < 2600; elapsed += 400) {
      scheduler.request();
      vi.advanceTimersByTime(400);
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("holds a change while nothing can be seen and runs it once, when it can", () => {
    const run = vi.fn();
    let visible = false;
    const scheduler = createSyncScheduler({ run, canRun: () => visible, quietMs: 100 });
    scheduler.request();
    scheduler.request();
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
    // Still hidden: resuming changes nothing.
    scheduler.resume();
    vi.advanceTimersByTime(10);
    expect(run).not.toHaveBeenCalled();
    visible = true;
    scheduler.resume();
    vi.advanceTimersByTime(10);
    expect(run).toHaveBeenCalledTimes(1);
    // And only once.
    scheduler.resume();
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("resuming with nothing waiting does nothing, and a stopped scheduler stays stopped", () => {
    const run = vi.fn();
    const scheduler = createSyncScheduler({ run, canRun: () => true, quietMs: 50 });
    scheduler.resume();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    scheduler.request();
    scheduler.dispose();
    vi.advanceTimersByTime(1000);
    scheduler.request();
    scheduler.resume();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
  });
});
