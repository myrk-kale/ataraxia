import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProviderUsage } from "../lib/usage";
import { UsageView } from "./UsageMeter";

const NOW = 1_000_000;

function usage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    provider: "claude",
    profile: null,
    plan: null,
    updatedAt: NOW - 120,
    windows: [
      { kind: "five_hour", usedPercent: 6, resetsAt: NOW + 3 * 3600 },
      { kind: "weekly", usedPercent: 76, resetsAt: NOW + 2 * 86400 },
    ],
    ...overrides,
  };
}

function render(value: ProviderUsage) {
  return renderToStaticMarkup(<UsageView label="Claude" now={NOW} usage={value} />);
}

describe("UsageView", () => {
  it("shows both limits in the bar with the share as a number", () => {
    const html = render(usage());
    expect(html).toContain(">5h<");
    expect(html).toContain(">Week<");
    expect(html).toMatch(/6%/);
    expect(html).toMatch(/76%/);
  });

  it("names the whole state on the button so it does not rest on the bars", () => {
    const html = render(usage());
    expect(html).toContain("Claude limits. 5-hour limit: 6% used, resets in 3 h");
    expect(html).toContain("Weekly limit: 76% used, resets in 2 d");
  });

  it("marks a limit that is close with an icon, not only with colour", () => {
    const calm = render(usage({ windows: [{ kind: "weekly", usedPercent: 10, resetsAt: NOW + 9 }] }));
    const close = render(usage({ windows: [{ kind: "weekly", usedPercent: 92, resetsAt: NOW + 9 }] }));
    expect(calm).not.toContain("lucide-triangle-alert");
    expect(close).toContain("lucide-triangle-alert");
  });

  it("says when a limit is reached", () => {
    const html = render(usage({ windows: [{ kind: "five_hour", usedPercent: 100, resetsAt: NOW + 600 }] }));
    expect(html).toContain("Limit reached");
    expect(html).toContain("Resets in 10 min");
  });

  it("does not claim use in a window that has since reset", () => {
    const html = render(usage({ windows: [{ kind: "weekly", usedPercent: 90, resetsAt: NOW - 60 }] }));
    expect(html).toContain("It has reset");
    expect(html).not.toContain("90%");
  });

  it("names the plan and says when and by whom it was reported", () => {
    const html = render(usage({ plan: "pro" }));
    expect(html).toContain(">Pro<");
    expect(html).toContain("Reported 2 min ago by Claude");
  });

  it("is a popover the button controls", () => {
    const html = render(usage());
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('popover="auto"');
    expect(html).toContain('aria-label="Claude usage limits"');
  });

  it("renders nothing for a report with no window", () => {
    expect(render(usage({ windows: [] }))).toBe("");
  });
});
