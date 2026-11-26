import { describe, expect, it } from "vitest";
import { ONBOARDING_KEY, ONBOARDING_VERSION, markOnboardingSeen, shouldShowOnboarding } from "./store";

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => void (data[key] = value), data };
}

describe("when the welcome tour is shown", () => {
  it("is shown to anybody with no mark, new or long-time users alike, and once marked it is not", () => {
    const store = memory();
    expect(shouldShowOnboarding(store)).toBe(true);
    markOnboardingSeen(store);
    expect(store.data[ONBOARDING_KEY]).toBe(String(ONBOARDING_VERSION));
    expect(shouldShowOnboarding(store)).toBe(false);
  });

  it("comes back when the tour is rewritten, and not for a mark that is nonsense", () => {
    expect(shouldShowOnboarding(memory({ [ONBOARDING_KEY]: String(ONBOARDING_VERSION - 1) }))).toBe(true);
    expect(shouldShowOnboarding(memory({ [ONBOARDING_KEY]: "later" }))).toBe(true);
    expect(shouldShowOnboarding(memory({ [ONBOARDING_KEY]: String(ONBOARDING_VERSION + 3) }))).toBe(false);
  });

  it("is not shown on every start when nothing can be remembered", () => {
    expect(shouldShowOnboarding(null)).toBe(false);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(shouldShowOnboarding(broken)).toBe(false);
    expect(() => markOnboardingSeen(broken)).not.toThrow();
    expect(() => markOnboardingSeen(null)).not.toThrow();
  });
});
