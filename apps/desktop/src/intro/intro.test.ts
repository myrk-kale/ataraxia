import { describe, expect, it } from "vitest";
import { GLYPHS, layout, pathD, TRACKING, WORD } from "./glyphs";
import {
  DRAW_END_MS,
  INTRO_MS,
  lerpPlacement,
  SETTLE_START_MS,
  settleAt,
  strokeProgress,
  wordPlacement,
} from "./timeline";

describe("the word", () => {
  it("is ATARAXIA in capitals, and every letter has a glyph", () => {
    expect(WORD).toBe("ATARAXIA");
    [...WORD].forEach((char) => expect(GLYPHS[char]).toBeDefined());
  });

  it("draws the A as two legs meeting at the top, with a crossbar between them", () => {
    const [legs, bar] = GLYPHS.A.strokes;
    expect(GLYPHS.A.strokes).toHaveLength(2);
    expect(legs.map((cmd) => cmd[0])).toEqual(["M", "L", "L"]);
    expect(legs[0].slice(1)).toEqual([0, 100]);
    expect(legs[1].slice(1)).toEqual([GLYPHS.A.width / 2, 0]);
    expect(legs[2].slice(1)).toEqual([GLYPHS.A.width, 100]);
    // The bar is level and sits between the legs, in the lower half.
    expect(bar[0][2]).toBe(bar[1][2]);
    expect(bar[0][2]).toBeGreaterThan(50);
    expect(bar[0][1]).toBeGreaterThan(0);
    expect(bar[1][1]).toBeLessThan(GLYPHS.A.width);
    expect(bar[0][1] + bar[1][1]).toBeCloseTo(GLYPHS.A.width);
  });

  it("lays the letters out left to right, with tracking and the letters' own side bearings", () => {
    const { items, width } = layout();
    expect(items.map((item) => item.char).join("")).toBe(WORD);
    items.slice(1).forEach((item, i) => {
      const before = items[i];
      expect(item.x - (before.x + before.glyph.width)).toBe(before.glyph.rsb + TRACKING + item.glyph.lsb);
    });
    const last = items[items.length - 1];
    expect(width).toBe(last.x + last.glyph.width);
    // The I stands alone with air on both sides; the A and the T sit close together.
    const gap = (i: number) => items[i + 1].x - (items[i].x + items[i].glyph.width);
    expect(gap(5)).toBeGreaterThan(gap(0));
    expect(gap(6)).toBeGreaterThan(gap(1));
  });

  it("centres the word in the window, with a size that follows the width", () => {
    const wide = wordPlacement(1400, 800);
    const narrow = wordPlacement(500, 800);
    const w = layout().width * wide.s;
    expect(wide.ox + w / 2).toBeCloseTo(700);
    expect(wide.s).toBeGreaterThan(narrow.s);
  });

  it("writes paths in pixels, scaled and offset", () => {
    expect(pathD(GLYPHS.A.strokes[0], { ox: 10, oy: 20, s: 0.5 })).toBe("M10.00 70.00 L30.75 20.00 L51.50 70.00");
    expect(pathD(GLYPHS.A.strokes[0], { ox: 0, oy: 0, s: 1 }, 100)).toBe("M100.00 100.00 L141.50 0.00 L183.00 100.00");
    expect(pathD(GLYPHS.R.strokes[0], { ox: 0, oy: 0, s: 1 })).toContain("C62.00 0.00 62.00 50.00 34.00 50.00");
  });
});

describe("timing", () => {
  it("draws every stroke, in order, before the settle starts", () => {
    expect(strokeProgress(0, 0, 0, 1)).toBe(0);
    expect(strokeProgress(DRAW_END_MS, 7, 0, 1)).toBe(1);
    expect(SETTLE_START_MS).toBeGreaterThan(DRAW_END_MS);
    // A later letter starts after an earlier one.
    expect(strokeProgress(100, 1, 0, 2)).toBeLessThan(strokeProgress(100, 0, 0, 2));
    // Within a letter, the second stroke waits for the first.
    expect(strokeProgress(150, 0, 1, 2)).toBe(0);
    expect(strokeProgress(150, 0, 0, 2)).toBeGreaterThan(0);
  });

  it("takes about two and a half seconds, with the whole word on screen before it ends", () => {
    expect(INTRO_MS).toBeGreaterThan(2000);
    expect(INTRO_MS).toBeLessThan(3000);
    for (let letter = 0; letter < WORD.length; letter += 1) {
      GLYPHS[WORD[letter]].strokes.forEach((_, k, all) => {
        expect(strokeProgress(DRAW_END_MS, letter, k, all.length)).toBe(1);
      });
    }
  });

  it("keeps the interface hidden while the word is drawn and holds before moving", () => {
    const held = settleAt(SETTLE_START_MS - 1);
    expect(held).toMatchObject({ fade: 0, travel: 0, backdrop: 1, done: false });
  });

  it("then fades the other letters, moves the first A and clears the backdrop", () => {
    const mid = settleAt(SETTLE_START_MS + 300);
    expect(mid.fade).toBeGreaterThan(0);
    expect(mid.travel).toBeGreaterThan(0);
    expect(mid.travel).toBeLessThan(1);
    expect(mid.backdrop).toBeLessThan(1);
    const end = settleAt(INTRO_MS - 1);
    expect(end).toMatchObject({ fade: 1, backdrop: 0, done: false });
    expect(end.travel).toBeGreaterThan(0.99);
    expect(settleAt(INTRO_MS).done).toBe(true);
  });

  it("never goes backwards", () => {
    let before = settleAt(0);
    for (let t = 10; t <= INTRO_MS; t += 10) {
      const now = settleAt(t);
      expect(now.fade).toBeGreaterThanOrEqual(before.fade);
      expect(now.travel).toBeGreaterThanOrEqual(before.travel);
      expect(now.backdrop).toBeLessThanOrEqual(before.backdrop);
      before = now;
    }
  });

  it("moves the first A between two placements exactly", () => {
    const a = { ox: 100, oy: 300, s: 0.56 };
    const b = { ox: 29, oy: 20, s: 0.2 };
    expect(lerpPlacement(a, b, 0)).toEqual(a);
    expect(lerpPlacement(a, b, 1)).toEqual(b);
  });
});
