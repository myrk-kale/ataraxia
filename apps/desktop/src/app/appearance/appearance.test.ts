import { describe, expect, it } from "vitest";
import { contrast, ensureContrast, parseColor, toHex } from "./color";
import { cleanFamily, clampSize, familyFor, fontVars, normalizeFonts, DEFAULT_FONTS } from "./fonts";
import { importVsCodeTheme, parseJsonc } from "./vscode";

// A theme as VS Code ships them: comments, trailing commas, a `type`, workbench colours and token rules.
const NIGHT = `{
  // A dark theme
  "name": "Night Owl Test",
  "type": "dark",
  "colors": {
    "editor.background": "#011627",
    "editor.foreground": "#d6deeb",
    "sideBar.background": "#010e1a",
    "button.background": "#7e57c2",
    "button.foreground": "#ffffffcc",
    "textLink.foreground": "#3b4a63", /* far too dim to read as a link */
    "terminal.ansiRed": "#ef5350",
    "terminal.ansiBlack": "#011627",
    "editor.selectionBackground": "#5f7e9779",
  },
  "tokenColors": [
    { "settings": { "foreground": "#d6deeb" } },
    { "scope": ["comment", "punctuation.definition.comment"], "settings": { "foreground": "#637777", "fontStyle": "italic" } },
    { "scope": "string.quoted.double.ts, string.template", "settings": { "foreground": "#ecc48d" } },
    { "scope": "keyword.control.flow", "settings": { "foreground": "#c792ea" } },
    { "scope": "source.ts meta.class entity.name.type.class", "settings": { "foreground": "#ffcb8b" } },
    { "scope": "constant.numeric", "settings": { "foreground": "#f78c6c" } },
  ],
}`;

describe("colour arithmetic", () => {
  it("reads hex colours in every length and rejects the rest", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#11223380")?.a).toBeCloseTo(0.5, 1);
    expect(parseColor("rgb(1,2,3)")).toBeNull();
    expect(parseColor("red")).toBeNull();
    expect(parseColor(undefined)).toBeNull();
  });

  it("pulls a colour toward readable only as far as the floor needs", () => {
    const panel = parseColor("#011627")!;
    const dim = parseColor("#3b4a63")!;
    expect(contrast(dim, panel)).toBeLessThan(4.5);
    const fixed = ensureContrast(dim, panel, 4.6);
    expect(contrast(fixed, panel)).toBeGreaterThanOrEqual(4.6);
    const fine = parseColor("#d6deeb")!;
    expect(toHex(ensureContrast(fine, panel, 4.5))).toBe("#d6deeb");
  });
});

describe("VS Code theme files", () => {
  it("reads comments and trailing commas as VS Code does, without touching strings", () => {
    const parsed = parseJsonc('{ "a": "http://x // not a comment", /* c */ "b": [1, 2,], }') as { a: string; b: number[] };
    expect(parsed).toEqual({ a: "http://x // not a comment", b: [1, 2] });
  });

  it("turns a theme into interface tokens that all read", () => {
    const theme = importVsCodeTheme(NIGHT, "night.json");
    expect(theme.name).toBe("Night Owl Test");
    expect(theme.id).toBe("vscode-night-owl-test");
    expect(theme.id).toMatch(/^[a-z0-9-]+$/);
    expect(theme.kind).toBe("dark");
    const at = (name: string) => parseColor(theme.vars[name])!;
    const panel = at("--cg-panel");
    expect(toHex(panel)).toBe("#011627");
    for (const text of ["--cg-ink", "--cg-muted", "--cg-muted-strong", "--cg-accent", "--cg-green", "--cg-red", "--cg-amber"]) {
      expect(contrast(at(text), panel), text).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(at("--cg-control"), panel)).toBeGreaterThanOrEqual(3);
    expect(contrast(at("--cg-on-primary"), at("--cg-primary"))).toBeGreaterThanOrEqual(4.5);
  });

  it("gives Monaco the workbench colours and the code colours it can apply", () => {
    const { monaco } = importVsCodeTheme(NIGHT);
    expect(monaco.base).toBe("vs-dark");
    expect(monaco.colors["editor.background"]).toBe("#011627");
    expect(monaco.colors["editor.selectionBackground"]).toBe("#5f7e9779");
    const comment = monaco.rules.find((rule) => rule.token === "comment");
    expect(comment).toMatchObject({ foreground: "637777", fontStyle: "italic" });
    expect(monaco.rules.find((rule) => rule.token === "string")?.foreground).toBe("ecc48d");
    expect(monaco.rules.find((rule) => rule.token === "keyword")?.foreground).toBe("c792ea");
    // "source.ts meta.class entity.name.type.class" colours the last part: the class name.
    expect(monaco.rules.find((rule) => rule.token === "type")?.foreground).toBe("ffcb8b");
    expect(monaco.rules.find((rule) => rule.token === "number")?.foreground).toBe("f78c6c");
  });

  it("builds a terminal palette, keeping ANSI colours visible against its background", () => {
    const { terminal } = importVsCodeTheme(NIGHT);
    expect(terminal.background).toBe("#010e1a");
    expect(terminal.red).toBe("#ef5350");
    // Black on a near-black terminal would vanish, so it is lifted a little.
    expect(terminal.black).not.toBe("#011627");
  });

  it("works out the kind of a theme that does not say", () => {
    const light = importVsCodeTheme(JSON.stringify({ name: "Paper", colors: { "editor.background": "#fdf6e3", "editor.foreground": "#586e75" } }));
    expect(light.kind).toBe("light");
    expect(light.monaco.base).toBe("vs");
    expect(contrast(parseColor(light.vars["--cg-ink"])!, parseColor("#fdf6e3")!)).toBeGreaterThanOrEqual(7);
    const contrastTheme = importVsCodeTheme(JSON.stringify({ name: "HC", type: "hc", colors: { "editor.background": "#000000" } }));
    expect(contrastTheme.monaco.base).toBe("hc-black");
  });

  it("says what is missing instead of failing quietly", () => {
    expect(importVsCodeTheme(JSON.stringify({ name: "Child", include: "./base.json", colors: { "editor.background": "#000" } })).warnings[0]).toMatch(/base\.json/);
    expect(() => importVsCodeTheme("not json")).toThrow(/not valid JSON/);
    expect(() => importVsCodeTheme("{}")).toThrow(/nothing of a theme/);
    expect(() => importVsCodeTheme(JSON.stringify({ contributes: { themes: [{ label: "A", path: "./themes/a.json" }] } }))).toThrow(/themes\/a\.json/);
  });

  it("names a theme after its file when it has no name", () => {
    expect(importVsCodeTheme(JSON.stringify({ colors: { "editor.background": "#000000" } }), "solar-dark.json").name).toBe("solar-dark");
  });
});

describe("fonts", () => {
  it("keeps a typeface list safe to put in CSS", () => {
    expect(cleanFamily("JetBrains Mono, Fira Code")).toBe('"JetBrains Mono", "Fira Code"');
    expect(cleanFamily("Menlo; } body { display:none")).not.toMatch(/[;{}:()]/);
    expect(cleanFamily("url(x), monospace")).toBe("urlx, monospace");
    expect(cleanFamily("   ")).toBe("");
  });

  it("puts the chosen face first and the area's own fallbacks after it", () => {
    expect(familyFor("code", { family: "Fira Code", size: 12 }).startsWith('"Fira Code", ')).toBe(true);
    expect(familyFor("code", { family: "", size: 12 })).toContain("Geist Mono");
  });

  it("keeps sizes in range, in half steps, and repairs bad stored settings", () => {
    expect(clampSize("code", 99)).toBe(28);
    expect(clampSize("code", 2)).toBe(10);
    expect(clampSize("interface", 13.26)).toBe(13.5);
    expect(clampSize("chat", Number.NaN)).toBe(14.5);
    expect(normalizeFonts(null)).toEqual(DEFAULT_FONTS);
    expect(normalizeFonts({ code: { family: 5, size: "big" } }).code).toEqual({ family: "", size: 12.5 });
  });

  it("scales the whole interface from its size and sets the faces as variables", () => {
    const vars = fontVars({ ...DEFAULT_FONTS, interface: { family: "Inter", size: 15.6 }, chat: { family: "", size: 16 } });
    expect(Number(vars["--cg-ui-scale"])).toBeCloseTo(1.2, 5);
    expect(vars["--cg-chat-size"]).toBe("16px");
    expect(vars["--font-sans"]?.startsWith("Inter, ")).toBe(true);
  });
});
