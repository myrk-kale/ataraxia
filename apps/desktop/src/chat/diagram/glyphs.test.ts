import { describe, expect, it } from "vitest";
import { DOWN, LEFT, RIGHT, STYLES, STYLE_NAMES, UP, allNarrow, isNarrow, lineGlyph } from "./glyphs";
import { MAX_GLYPHS, charOf, glyph, glyphCount } from "./registry";
import { CLASS_COUNT, TOKEN_OF, buildPalette, parseColor } from "./palette";

describe("lineGlyph", () => {
  it("draws a single arm as a straight piece and two opposite arms too", () => {
    for (const name of STYLE_NAMES) {
      const style = STYLES[name];
      expect(lineGlyph(style, LEFT)).toBe(style.h);
      expect(lineGlyph(style, RIGHT | LEFT)).toBe(style.h);
      expect(lineGlyph(style, UP)).toBe(style.v);
      expect(lineGlyph(style, UP | DOWN)).toBe(style.v);
    }
  });

  it("draws every corner, tee and crossing in every style, all single-cell characters", () => {
    const shapes = [UP | RIGHT, RIGHT | DOWN, UP | LEFT, DOWN | LEFT, UP | RIGHT | DOWN, UP | RIGHT | LEFT, UP | DOWN | LEFT, RIGHT | DOWN | LEFT, 15];
    for (const name of STYLE_NAMES) {
      const seen = shapes.map((bits) => lineGlyph(STYLES[name], bits));
      seen.forEach((char) => expect([...char]).toHaveLength(1));
      if (name !== "ascii") {
        expect(new Set(seen).size).toBe(shapes.length);
      }
    }
  });

  it("puts the corner glyphs where a corner points", () => {
    const rounded = STYLES.rounded;
    expect(lineGlyph(rounded, RIGHT | DOWN)).toBe(rounded.tl);
    expect(lineGlyph(rounded, DOWN | LEFT)).toBe(rounded.tr);
    expect(lineGlyph(rounded, UP | RIGHT)).toBe(rounded.bl);
    expect(lineGlyph(rounded, UP | LEFT)).toBe(rounded.br);
  });
});

describe("isNarrow", () => {
  it("accepts text in Latin scripts, with accents, and box drawing", () => {
    expect(allNarrow("Serviço de Autenticação ─│┌ ►")).toBe(true);
    expect(allNarrow("Привет Ελληνικά")).toBe(true);
  });

  it("refuses what is two cells wide or has no width", () => {
    expect(isNarrow("日")).toBe(false);
    expect(isNarrow("한")).toBe(false);
    expect(isNarrow("😀")).toBe(false);
    expect(isNarrow("​")).toBe(false);
    expect(isNarrow("́")).toBe(false);
    expect(isNarrow("\n")).toBe(false);
    expect(allNarrow("ok 日本")).toBe(false);
  });
});

describe("registry", () => {
  it("numbers a character once, with the empty cell as zero", () => {
    expect(glyph(" ")).toBe(0);
    const a = glyph("Ж");
    expect(glyph("Ж")).toBe(a);
    expect(charOf(a)).toBe("Ж");
    expect(a).toBeGreaterThan(0);
  });

  it("stops growing and answers with a question mark past its limit", () => {
    for (let code = 0x4e00 - 0x400; code < 0x4e00 + MAX_GLYPHS; code += 1) {
      glyph(String.fromCodePoint(code % 0xd800));
    }
    expect(glyphCount()).toBeLessThanOrEqual(MAX_GLYPHS);
    expect(charOf(glyph(String.fromCodePoint(0x1f600)))).toBeTruthy();
  });
});

describe("palette", () => {
  it("reads hex and rgb colours", () => {
    expect(parseColor("#ff0000")).toEqual([1, 0, 0]);
    expect(parseColor("#0f0")).toEqual([0, 1, 0]);
    expect(parseColor("rgb(0, 0, 255)")).toEqual([0, 0, 1]);
    expect(parseColor("rgba(255, 255, 255, 0.5)")).toEqual([1, 1, 1]);
    expect(parseColor("not a colour")).toBeNull();
  });

  it("gives every class a colour, and a mid grey for a token it cannot read", () => {
    expect(TOKEN_OF).toHaveLength(CLASS_COUNT);
    const palette = buildPalette((token) => (token === "--cg-ink" ? "#102030" : "nope"));
    expect(palette).toHaveLength(CLASS_COUNT * 3);
    expect(palette[3 * 3]).toBeCloseTo(0x10 / 255);
    expect(palette[2 * 3]).toBe(0.5);
  });
});
