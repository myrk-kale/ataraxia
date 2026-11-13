import { describe, expect, it } from "vitest";
import { usesOverlayTitlebar } from "./titlebar";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/120.0";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";

describe("usesOverlayTitlebar", () => {
  it("is for the macOS app only", () => {
    expect(usesOverlayTitlebar({ userAgent: MAC, tauri: true })).toBe(true);
  });

  it("leaves Windows and Linux with their own title bar", () => {
    expect(usesOverlayTitlebar({ userAgent: WINDOWS, tauri: true })).toBe(false);
    expect(usesOverlayTitlebar({ userAgent: LINUX, tauri: true })).toBe(false);
  });

  it("is off in a browser on a Mac, which has no window buttons over the page", () => {
    expect(usesOverlayTitlebar({ userAgent: MAC, tauri: false })).toBe(false);
  });
});
