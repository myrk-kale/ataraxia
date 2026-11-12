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

  it("draws the A as a bare Λ: one stroke, feet on the baseline and the apex at the top", () => {
    const [stroke] = GLYPHS.A.strokes;
    expect(GLYPHS.A.strokes).toHaveLength(1);
    expect(stroke.map((cmd) => cmd[0])).toEqual(["M", "L", "L"]);
    expect(stroke[0].slice(1)).toEqual([0, 100]);
    expect(stroke[1].slice(1)).toEqual([30, 0]);
    expect(stroke[2].slice(1)).toEqual([60, 100]);
  });

  it("lays the letters out left to right with the same tracking between them", () => {
    const { items, width } = layout();
    expect(items.map((item) => item.char).join("")).toBe(WORD);
    items.slice(1).forEach((item, i) => {
      expect(item.x - (items[i].x + items[i].glyph.width)).toBe(TRACKING);
    });
    const last = items[items.length - 1];
    expect(width).toBe(last.x + last.glyph.width);
  });

  it("centres the word in the window, with a size that follows the width", () => {
    const wide = wordPlacement(1400, 800);
    const narrow = wordPlacement(500, 800);
    const w = layout().width * wide.s;
    expect(wide.ox + w / 2).toBeCloseTo(700);
    expect(wide.s).toBeGreaterThan(narrow.s);
  });

  it("writes paths in pixels, scaled and offset", () => {
    expect(pathD(GLYPHS.A.strokes[0], { ox: 10, oy: 20, s: 0.5 })).toBe("M10.00 70.00 L25.00 20.00 L40.00 70.00");
    expect(pathD(GLYPHS.A.strokes[0], { ox: 0, oy: 0, s: 1 }, 100)).toBe("M100.00 100.00 L130.00 0.00 L160.00 100.00");
    expect(pathD(GLYPHS.R.strokes[0], { ox: 0, oy: 0, s: 1 })).toContain("C52.00 0.00 52.00 52.00 26.00 52.00");
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
