import { describe, expect, it } from "vitest";
import { normalizeSound } from "./sound";

describe("sound settings", () => {
  it("are on and quiet by default, and a stored value is made whole and in range", () => {
    expect(normalizeSound(null)).toEqual({ enabled: true, volume: 0.6 });
    expect(normalizeSound({ enabled: false, volume: 3 })).toEqual({ enabled: false, volume: 1 });
    expect(normalizeSound({ enabled: "no", volume: -1 })).toEqual({ enabled: true, volume: 0 });
    expect(normalizeSound({ volume: Number.NaN }).volume).toBe(0.6);
  });
});
