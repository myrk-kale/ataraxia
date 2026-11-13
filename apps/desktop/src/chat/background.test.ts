// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

describe("the background preference", () => {
  it("is on unless it was turned off, whatever else is stored", async () => {
    const { normalizeBackground } = await import("./background");
    expect(normalizeBackground(null)).toBe(true);
    expect(normalizeBackground("on")).toBe(true);
    expect(normalizeBackground("nonsense")).toBe(true);
    expect(normalizeBackground("off")).toBe(false);
    expect(normalizeBackground(false)).toBe(false);
  });

  it("starts from what is stored and remembers a change", async () => {
    window.localStorage.setItem("ataraxia.background", "off");
    const first = await import("./background");
    first.setBackground(true);
    expect(window.localStorage.getItem("ataraxia.background")).toBe("on");
    first.setBackground(false);
    expect(window.localStorage.getItem("ataraxia.background")).toBe("off");

    vi.resetModules();
    window.localStorage.setItem("ataraxia.background", "off");
    const second = await import("./background");
    expect(second.normalizeBackground(window.localStorage.getItem("ataraxia.background"))).toBe(false);
  });
});
