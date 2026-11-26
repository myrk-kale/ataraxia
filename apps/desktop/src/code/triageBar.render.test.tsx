// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { elapsed, runningHint, TriageBar } from "./TriageBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const handlers = { onStart: vi.fn(), onCancel: vi.fn(), onUndo: vi.fn(), onShowSkipped: vi.fn() };
const idle = { count: 12, startedAt: null, note: null, error: null, skipped: 0, showSkipped: false };
const button = (text: string) => [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(text))!;

function show(props: Partial<Parameters<typeof TriageBar>[0]> = {}) {
  act(() => root.render(<TriageBar {...idle} {...handlers} {...props} />));
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.values(handlers).forEach((mock) => mock.mockClear());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("how long a triage has gone, in words", () => {
  it("writes minutes and seconds", () => {
    expect(elapsed(0)).toBe("0:00");
    expect(elapsed(42_000)).toBe("0:42");
    expect(elapsed(125_000)).toBe("2:05");
    expect(elapsed(-5)).toBe("0:00");
  });

  it("says something different as it takes longer, and always that cancelling keeps the order", () => {
    expect(runningHint(5_000)).toContain("keep reviewing");
    expect(runningHint(60_000)).toContain("couple of minutes");
    expect(runningHint(200_000)).toContain("longer than usual");
    expect(runningHint(60_000)).toContain("cancel");
    expect(runningHint(200_000)).toContain("Cancel");
  });
});

describe("the triage bar", () => {
  it("is a labelled button in plain view with what it does written under it", () => {
    show();
    expect(button("Prioritize with a subagent")).toBeDefined();
    expect(host.textContent).toContain("Orders the 12 changes and leaves out what needs no review");
    act(() => button("Prioritize with a subagent").click());
    expect(handlers.onStart).toHaveBeenCalledTimes(1);
  });

  it("cannot start with nothing in the queue, and says change for one", () => {
    show({ count: 0 });
    expect((button("Prioritize with a subagent") as HTMLButtonElement).disabled).toBe(true);
    show({ count: 1 });
    expect(host.textContent).toContain("Orders the 1 change ");
  });

  it("says what it is doing while it runs, counts the time and can be cancelled", () => {
    const started = Date.now();
    show({ startedAt: started });
    const panel = host.querySelector('[role="status"]')!;
    expect(panel.textContent).toContain("A subagent is reading 12 changes");
    expect(panel.textContent).toContain("0:00");
    expect(panel.textContent).toContain("keep reviewing");
    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    expect(panel.textContent).toContain("1:05");
    expect(panel.textContent).toContain("couple of minutes");
    // While it runs there is nothing to start again.
    expect(host.textContent).not.toContain("Prioritize with a subagent");
    act(() => button("Cancel").click());
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it("reports what it did, offers to show what was left out and to undo it", () => {
    show({ note: "Reordered 9, left out 3 that need no review.", skipped: 3 });
    expect(host.textContent).toContain("Reordered 9, left out 3");
    expect(host.textContent).not.toContain("Orders the 12 changes");
    act(() => button("3 left out · show").click());
    expect(handlers.onShowSkipped).toHaveBeenCalledWith(true);
    act(() => button("Undo the triage").click());
    expect(handlers.onUndo).toHaveBeenCalledTimes(1);
    show({ note: "x", skipped: 3, showSkipped: true });
    expect(button("Hide the 3 left out")).toBeDefined();
  });

  it("says why it failed where the button is, and the button is there to try again", () => {
    show({ error: "The triage did not finish: the agent took too long to answer" });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("took too long");
    act(() => button("Prioritize with a subagent").click());
    expect(handlers.onStart).toHaveBeenCalled();
  });
});
