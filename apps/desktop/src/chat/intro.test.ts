import { describe, expect, it } from "vitest";
import { INTRO_FADE_MS, INTRO_MS, introOpacity } from "./intro";

describe("introOpacity", () => {
  it("lasts between one and two seconds", () => {
    expect(INTRO_MS).toBeGreaterThanOrEqual(1000);
    expect(INTRO_MS).toBeLessThanOrEqual(2000);
  });

  it("is fully opaque until the short fade starts, then gone", () => {
    expect(introOpacity(0)).toBe(1);
    expect(introOpacity(INTRO_MS - INTRO_FADE_MS)).toBe(1);
    expect(introOpacity(INTRO_MS)).toBe(0);
    expect(introOpacity(INTRO_MS + 500)).toBe(0);
  });

  it("fades out steadily at the end", () => {
    const mid = introOpacity(INTRO_MS - INTRO_FADE_MS / 2);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });
});
