import { describe, expect, it } from "vitest";
import { progressPercent, progressText } from "./speech";

describe("the speech model download", () => {
  it("says how much has arrived, with the total when it is known", () => {
    expect(progressText({ received: 143_500_000, total: 574_000_000 })).toBe("144 of 574 MB");
    expect(progressText({ received: 12_000_000, total: null })).toBe("12 MB");
  });

  it("gives a percentage only when the total is known, never above 100", () => {
    expect(progressPercent({ received: 287_000_000, total: 574_000_000 })).toBe(50);
    expect(progressPercent({ received: 600_000_000, total: 574_000_000 })).toBe(100);
    expect(progressPercent({ received: 5, total: null })).toBeNull();
  });
});
