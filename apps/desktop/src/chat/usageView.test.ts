import { describe, expect, it } from "vitest";
import type { ProviderUsage } from "../lib/usage";
import {
  describeWindow,
  formatAge,
  formatReset,
  levelOf,
  planLabel,
  viewUsage,
  viewWindow,
} from "./usageView";

const NOW = 1_000_000;

describe("levelOf", () => {
  it("warns from 75, urges from 90 and says full at 100", () => {
    expect([0, 74, 75, 89, 90, 99, 100].map(levelOf)).toEqual([
      "ok",
      "ok",
      "warn",
      "warn",
      "high",
      "high",
      "full",
    ]);
  });
});

describe("viewWindow", () => {
  it("shows what the provider reported while the window is still running", () => {
    const view = viewWindow({ kind: "five_hour", usedPercent: 6, resetsAt: NOW + 3 * 3600 }, NOW);
    expect(view).toMatchObject({ percent: 6, level: "ok", reset: false, secondsLeft: 3 * 3600 });
    expect(view.short).toBe("5h");
  });

  it("counts a window that ended since the last report as unused", () => {
    const view = viewWindow({ kind: "weekly", usedPercent: 91, resetsAt: NOW - 1 }, NOW);
    expect(view).toMatchObject({ percent: 0, level: "ok", reset: true, secondsLeft: null });
  });

  it("keeps a window with no reset time as reported", () => {
    const view = viewWindow({ kind: "weekly", usedPercent: 40, resetsAt: null }, NOW);
    expect(view).toMatchObject({ percent: 40, reset: false, secondsLeft: null });
  });

  it("holds a share out of range to 0 through 100", () => {
    expect(viewWindow({ kind: "weekly", usedPercent: 140, resetsAt: null }, NOW).percent).toBe(100);
    expect(viewWindow({ kind: "weekly", usedPercent: -3, resetsAt: null }, NOW).percent).toBe(0);
  });
});

describe("viewUsage", () => {
  const usage = (windows: ProviderUsage["windows"]): ProviderUsage => ({
    provider: "claude",
    profile: null,
    plan: null,
    windows,
    updatedAt: NOW,
  });

  it("puts the five-hour window before the weekly one whatever the order reported", () => {
    const views = viewUsage(
      usage([
        { kind: "weekly", usedPercent: 76, resetsAt: NOW + 10 },
        { kind: "five_hour", usedPercent: 6, resetsAt: NOW + 10 },
      ]),
      NOW,
    );
    expect(views.map((view) => view.kind)).toEqual(["five_hour", "weekly"]);
  });

  it("shows only the windows the provider has", () => {
    const views = viewUsage(usage([{ kind: "weekly", usedPercent: 5, resetsAt: null }]), NOW);
    expect(views).toHaveLength(1);
  });
});

describe("words", () => {
  it("counts down in the largest sensible units", () => {
    expect(formatReset(20)).toBe("in 1 min");
    expect(formatReset(42 * 60)).toBe("in 42 min");
    expect(formatReset(3 * 3600 + 12 * 60)).toBe("in 3 h 12 min");
    expect(formatReset(5 * 3600)).toBe("in 5 h");
    expect(formatReset(2 * 86400 + 4 * 3600)).toBe("in 2 d 4 h");
  });

  it("says how long ago it was reported", () => {
    expect(formatAge(NOW, NOW + 10)).toBe("just now");
    expect(formatAge(NOW, NOW + 12 * 60)).toBe("12 min ago");
    expect(formatAge(NOW, NOW + 3 * 3600)).toBe("3 h ago");
    expect(formatAge(NOW, NOW + 3 * 86400)).toBe("3 d ago");
  });

  it("states a window in words for a screen reader", () => {
    const live = viewWindow({ kind: "five_hour", usedPercent: 6, resetsAt: NOW + 90 * 60 }, NOW);
    expect(describeWindow(live)).toBe("5-hour limit: 6% used, resets in 1 h 30 min");
    const over = viewWindow({ kind: "weekly", usedPercent: 99, resetsAt: NOW - 5 }, NOW);
    expect(describeWindow(over)).toBe("Weekly limit: reset, nothing used yet");
  });

  it("spells a plan for people", () => {
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("self_serve_business_prolite")).toBe("Self Serve Business Prolite");
  });
});
