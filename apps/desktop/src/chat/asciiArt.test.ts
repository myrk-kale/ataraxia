import { describe, expect, it } from "vitest";
import { brightness, COLUMN_HALF, glyphFor, markFor, MAX_ALPHA, nearest, QUIET_ALPHA, quiet, RAMP, STILL_AT } from "./asciiArt";

describe("the A", () => {
  it("is centred, kept inside the area, and has the proportions of the logo", () => {
    const mark = markFor(1200, 700);
    expect(mark.apex.x).toBe(600);
    expect((mark.left.x + mark.right.x) / 2).toBeCloseTo(600);
    expect(mark.left.y).toBe(mark.right.y);
    expect(mark.apex.y).toBeGreaterThan(0);
    expect(mark.left.y).toBeLessThan(700);
    expect((mark.right.x - mark.left.x) / (mark.left.y - mark.apex.y)).toBeCloseTo(0.83);
    // The bar is level, between the legs, in the lower half.
    expect(mark.barLeft.y).toBe(mark.barRight.y);
    expect(mark.barLeft.y).toBeGreaterThan(700 / 2);
    expect(mark.barLeft.x).toBeGreaterThan(mark.left.x);
    expect(mark.barRight.x).toBeLessThan(mark.right.x);
  });

  it("shrinks to fit a narrow area instead of running off it", () => {
    const mark = markFor(300, 900);
    expect(mark.left.x).toBeGreaterThanOrEqual(0);
    expect(mark.right.x).toBeLessThanOrEqual(300);
  });

  it("knows how far a point is from the strokes, and which part is closest", () => {
    const mark = markFor(1000, 800);
    expect(nearest(mark, mark.apex).d).toBeCloseTo(0);
    expect(nearest(mark, mark.left).along).toBeCloseTo(0);
    expect(nearest(mark, mark.right).along).toBeCloseTo(1);
    const middleOfBar = { x: 500, y: mark.barLeft.y };
    expect(nearest(mark, middleOfBar)).toMatchObject({ bar: expect.closeTo(0.5, 1) });
    expect(nearest(mark, { x: 5, y: 5 }).d).toBeGreaterThan(100);
  });
});

describe("brightness", () => {
  const mark = markFor(1000, 800);
  const onLeg = { x: (mark.left.x + mark.apex.x) / 2, y: (mark.left.y + mark.apex.y) / 2 };
  const faraway = { x: 20, y: 20 };

  it("is strong on the strokes and faint far from them", () => {
    expect(brightness(mark, onLeg, STILL_AT)).toBeGreaterThan(0.55);
    expect(brightness(mark, faraway, STILL_AT)).toBeLessThan(0.4);
  });

  it("stays between 0 and 1 at any time and place", () => {
    for (let t = 0; t < 40; t += 1.7) {
      for (let x = 0; x < 1000; x += 97) {
        for (let y = 0; y < 800; y += 89) {
          const value = brightness(mark, { x, y }, t, { x: 500, y: 400 });
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("moves: a light travels along the stroke, so one point is not always as bright", () => {
    const values = Array.from({ length: 90 }, (_, i) => brightness(mark, onLeg, i * 0.1));
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.15);
  });

  it("is calm: neighbouring moments differ little, so nothing flickers", () => {
    let worst = 0;
    for (let t = 0; t < 30; t += 0.033) {
      for (const p of [onLeg, faraway, { x: 400, y: 300 }]) {
        worst = Math.max(worst, Math.abs(brightness(mark, p, t + 0.033) - brightness(mark, p, t)));
      }
    }
    expect(worst).toBeLessThan(0.05);
  });

  it("lights the characters near the cursor, and only near it", () => {
    const empty = { x: 150, y: 700 };
    const without = brightness(mark, empty, 5);
    expect(brightness(mark, empty, 5, empty)).toBeGreaterThan(without + 0.1);
    expect(brightness(mark, empty, 5, { x: 900, y: 100 })).toBeCloseTo(without);
  });

  it("is the same picture for the same moment", () => {
    expect(brightness(mark, onLeg, 4.2)).toBe(brightness(mark, onLeg, 4.2));
  });
});

describe("the A rising away", () => {
  const rested = markFor(1000, 800, 0);

  it("is in place at first, climbs, and has faded out before the end", () => {
    expect(markFor(1000, 800)).toEqual(rested);
    expect(rested.presence).toBe(1);
    let y = rested.apex.y;
    let presence = 1;
    for (let lift = 0.1; lift <= 1.0001; lift += 0.1) {
      const now = markFor(1000, 800, lift);
      expect(now.apex.y).toBeLessThan(y);
      expect(now.presence).toBeLessThanOrEqual(presence);
      y = now.apex.y;
      presence = now.presence;
    }
    expect(markFor(1000, 800, 0.8).presence).toBe(0);
    expect(markFor(1000, 800, 1).presence).toBe(0);
  });

  it("leaves only the field: nothing is bright where the A used to be, and the field fills the space", () => {
    const gone = markFor(1000, 800, 1);
    const onLeg = { x: (rested.left.x + rested.apex.x) / 2, y: (rested.left.y + rested.apex.y) / 2 };
    const peak = (p: { x: number; y: number }, m: typeof gone) =>
      Math.max(...Array.from({ length: 200 }, (_, i) => brightness(m, p, i * 0.5)));
    expect(peak(onLeg, rested)).toBeGreaterThan(0.8);
    // Only the field is left there: never as bright as the stroke was.
    expect(peak(onLeg, gone)).toBeLessThan(0.7);
    expect(peak(onLeg, gone)).toBeLessThan(peak(onLeg, rested) - 0.2);
    // The field also drifts through the place the A kept clear.
    const inside = { x: 500, y: rested.barLeft.y - 60 };
    expect(peak(inside, gone)).toBeGreaterThan(peak(inside, rested));
  });

  it("still drifts once the A is gone: the lit characters of the whole picture move", () => {
    const gone = markFor(1000, 800, 1);
    const lit = (t: number) => {
      const cells = new Set<string>();
      for (let x = 0; x < 1000; x += 8) {
        for (let y = 0; y < 800; y += 15) {
          if (glyphFor(brightness(gone, { x, y }, t)) !== " ") cells.add(`${x},${y}`);
        }
      }
      return cells;
    };
    const early = lit(0);
    const later = lit(8);
    expect(early.size).toBeGreaterThan(100);
    // Mostly different places, so it is a drift and not a flicker in the same spots.
    const shared = [...early].filter((cell) => later.has(cell)).length;
    expect(shared / early.size).toBeLessThan(0.6);
  });
});

describe("the background behind a conversation", () => {
  const W = 1280;
  const H = 700;
  const gone = markFor(W, H, 1);

  it("is quiet across the whole height of the message column, and lively in the margins", () => {
    const floor = QUIET_ALPHA / MAX_ALPHA;
    for (const y of [10, 200, 350, 600, 690]) {
      expect(quiet(W, H, { x: W / 2, y }, 1)).toBeCloseTo(floor);
      expect(quiet(W, H, { x: W / 2 + COLUMN_HALF - 1, y }, 1)).toBeCloseTo(floor);
    }
    expect(quiet(W, H, { x: 30, y: 350 }, 1)).toBe(1);
    expect(quiet(W, H, { x: W - 30, y: 90 }, 1)).toBe(1);
  });

  it("settles into the quiet column over the first part of the rise, never abruptly", () => {
    const where = { x: W / 2 - 150, y: 40 };
    expect(quiet(W, H, where, 0)).toBeGreaterThan(0.9);
    expect(quiet(W, H, where, 0.6)).toBeCloseTo(QUIET_ALPHA / MAX_ALPHA);
    let before = quiet(W, H, where, 0);
    for (let lift = 0.05; lift <= 0.6; lift += 0.05) {
      const now = quiet(W, H, where, lift);
      expect(now).toBeLessThanOrEqual(before + 1e-9);
      expect(before - now).toBeLessThan(0.25);
      before = now;
    }
  });

  it("never lets the art exceed the quiet alpha anywhere in the message column, at any moment", () => {
    // The worst a word can sit on: this is what the contrast proof below is about.
    let worst = 0;
    for (let t = 0; t < 120; t += 0.9) {
      for (let x = W / 2 - COLUMN_HALF; x <= W / 2 + COLUMN_HALF; x += 37) {
        for (let y = 0; y < H; y += 41) {
          const p = { x, y };
          const level = brightness(gone, p, t, { x, y });
          worst = Math.max(worst, Math.min(1, level) * MAX_ALPHA * quiet(W, H, p, 1));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(QUIET_ALPHA + 1e-9);
  });
});

describe("characters", () => {
  it("run from empty to the densest, in ASCII", () => {
    expect(glyphFor(0)).toBe(" ");
    expect(glyphFor(1)).toBe("@");
    expect(glyphFor(-3)).toBe(" ");
    expect(glyphFor(9)).toBe("@");
    expect([...RAMP].every((char) => char.charCodeAt(0) < 128)).toBe(true);
  });
});

describe("the quiet middle", () => {
  it("is full strength at the edges and keeps the art faint where the words are", () => {
    expect(quiet(1200, 700, { x: 20, y: 20 })).toBe(1);
    const middle = quiet(1200, 700, { x: 600, y: 350 });
    expect(middle * MAX_ALPHA).toBeCloseTo(QUIET_ALPHA);
    // Grows steadily from the middle outward.
    let before = middle;
    for (let x = 600; x <= 1200; x += 30) {
      const now = quiet(1200, 700, { x, y: 350 });
      expect(now).toBeGreaterThanOrEqual(before - 1e-9);
      before = now;
    }
  });
});

// WCAG 2 contrast, to prove the words stay readable over the faintest the art can be there.
function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
function blend(under: string, over: string, alpha: number): string {
  const mix = (i: number) =>
    Math.round(parseInt(under.slice(1 + i * 2, 3 + i * 2), 16) * (1 - alpha) + parseInt(over.slice(1 + i * 2, 3 + i * 2), 16) * alpha);
  return `#${[0, 1, 2].map((i) => mix(i).toString(16).padStart(2, "0")).join("")}`;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the words over the art", () => {
  // The tokens in styles/index.css: --cg-panel, --cg-ink, --cg-muted and --cg-muted-strong.
  const themes = {
    light: { panel: "#ffffff", ink: "#232522", muted: "#686b66", strong: "#50534e" },
    dark: { panel: "#161715", ink: "#e8e9e6", muted: "#8b8e89", strong: "#a9aca6" },
  };

  for (const [name, t] of Object.entries(themes)) {
    it(`keep 4.5:1 in the ${name} theme, even on the densest character of the quiet middle`, () => {
      // A character pixel is the art colour at the quiet middle's alpha, the worst a word can sit on.
      const worst = blend(t.panel, t.ink, QUIET_ALPHA);
      for (const text of [t.ink, t.strong, t.muted]) {
        expect(contrast(text, worst)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
