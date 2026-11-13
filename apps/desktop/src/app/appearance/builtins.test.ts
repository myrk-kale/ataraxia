import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES, DEFAULT_FAMILY, builtInTheme } from "./builtins";
import { contrast, parseColor } from "./color";

const rgb = (hex: string) => parseColor(hex)!;

describe("built-in themes", () => {
  it("ships eleven, each with a light and a dark variant", () => {
    expect(BUILT_IN_THEMES).toHaveLength(11);
    expect(new Set(BUILT_IN_THEMES.map((theme) => theme.id)).size).toBe(11);
    for (const { id } of BUILT_IN_THEMES) {
      if (id === DEFAULT_FAMILY) {
        // Ataraxia is the stylesheet's own.
        expect(builtInTheme(id, "light")).toBeNull();
        continue;
      }
      expect(builtInTheme(id, "light")?.kind, id).toBe("light");
      expect(builtInTheme(id, "dark")?.kind, id).toBe("dark");
    }
  });

  it("gives every variant a Monaco-safe id and a terminal palette", () => {
    for (const { id } of BUILT_IN_THEMES) {
      for (const kind of ["light", "dark"] as const) {
        const theme = builtInTheme(id, kind);
        if (!theme) continue;
        expect(theme.id, `${id} ${kind}`).toMatch(/^[a-z0-9-]+$/);
        expect(theme.terminal.red).toBeTruthy();
        expect(theme.monaco.rules.length).toBeGreaterThan(3);
      }
    }
  });

  it("keeps text readable on every variant", () => {
    for (const { id } of BUILT_IN_THEMES) {
      for (const kind of ["light", "dark"] as const) {
        const theme = builtInTheme(id, kind);
        if (!theme) continue;
        const v = theme.vars;
        const panel = rgb(v["--cg-panel"]!);
        const label = `${id} ${kind}`;
        expect(contrast(rgb(v["--cg-ink"]!), panel), `${label} ink`).toBeGreaterThanOrEqual(7);
        expect(contrast(rgb(v["--cg-muted"]!), panel), `${label} muted`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(rgb(v["--cg-accent"]!), panel), `${label} accent`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(rgb(v["--cg-control"]!), panel), `${label} control`).toBeGreaterThanOrEqual(3);
        expect(contrast(rgb(v["--cg-on-primary"]!), rgb(v["--cg-primary"]!)), `${label} primary`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
