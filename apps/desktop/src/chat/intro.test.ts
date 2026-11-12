import { describe, expect, it } from "vitest";
import { easeInOutCubic, INTRO_CEILING, INTRO_MS, introShape, REVEAL_START_MS, revealRadius } from "./intro";

const W = 1200;
const H = 800;
const calm = { alpha: 0.1, offsetY: 0, radius: 1 };

describe("timing", () => {
  it("lasts between one and two seconds, revealing in the second half", () => {
    expect(INTRO_MS).toBeGreaterThanOrEqual(1000);
    expect(INTRO_MS).toBeLessThanOrEqual(2000);
    expect(REVEAL_START_MS).toBeGreaterThan(INTRO_MS / 3);
    expect(REVEAL_START_MS).toBeLessThan(INTRO_MS);
  });

  it("eases in and out between 0 and 1", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(0.25)).toBeLessThan(0.25);
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });
});

describe("revealRadius", () => {
  it("stays closed until the reveal starts, then grows past the corners", () => {
    expect(revealRadius(0, W, H)).toBe(0);
    expect(revealRadius(REVEAL_START_MS, W, H)).toBe(0);
    const mid = revealRadius((REVEAL_START_MS + INTRO_MS) / 2, W, H);
    expect(mid).toBeGreaterThan(0);
    expect(revealRadius(INTRO_MS, W, H)).toBeGreaterThan(Math.hypot(W, H) / 2);
    expect(revealRadius(INTRO_MS, W, H)).toBeGreaterThan(mid);
  });
});

describe("introShape", () => {
  it("starts empty and spreads out from the centre", () => {
    expect(introShape(0, W, H)(W / 2 + 5, H / 2, calm)).toBeNull();
    const early = introShape(200, W, H);
    expect(early(W / 2 + 40, H / 2, calm)).not.toBeNull();
    expect(early(W / 2 + 900, H / 2, calm)).toBeNull();
  });

  it("fills the window once the bloom has reached the corners", () => {
    const shape = introShape(800, W, H);
    for (const [x, y] of [[6, 6], [W - 6, H - 6], [W / 2, 6]]) {
      expect(shape(x, y, calm)).not.toBeNull();
    }
  });

  it("makes a shock ring brighter, bigger and pushed outward", () => {
    const shape = introShape(400, W, H);
    const ring = 400 * 0.95;
    const onRing = shape(W / 2 + ring, H / 2, calm)!;
    const away = shape(W / 2 + ring - 300, H / 2, calm)!;
    expect(onRing.alpha).toBeGreaterThan(away.alpha);
    expect(onRing.radius).toBeGreaterThan(away.radius);
    expect(onRing.x).toBeGreaterThan(W / 2 + ring);
  });

  it("removes the dots inside the opening and lights the ones on its rim", () => {
    const elapsed = (REVEAL_START_MS + INTRO_MS) / 2;
    const shape = introShape(elapsed, W, H);
    const open = revealRadius(elapsed, W, H);
    expect(shape(W / 2 + open - 30, H / 2, calm)).toBeNull();
    const rim = shape(W / 2 + open + 10, H / 2, calm)!;
    const far = shape(W / 2 + open + 300, H / 2, calm);
    expect(rim.radius).toBeGreaterThan(calm.radius + 1);
    if (far) {
      expect(rim.alpha).toBeGreaterThan(far.alpha);
    }
  });

  it("never exceeds the ceiling and ends with nothing left", () => {
    for (const elapsed of [100, 500, 1000, 1400, 1800]) {
      const shape = introShape(elapsed, W, H);
      for (let x = 6; x < W; x += 97) {
        for (let y = 6; y < H; y += 89) {
          const dot = shape(x, y, { alpha: 0.36, offsetY: 3, radius: 1.2 });
          if (dot) {
            expect(dot.alpha).toBeLessThanOrEqual(INTRO_CEILING);
          }
        }
      }
    }
    const last = introShape(INTRO_MS, W, H);
    for (const [x, y] of [[6, 6], [W / 2, H / 2], [W - 6, H - 6]]) {
      expect(last(x, y, calm)).toBeNull();
    }
  });
});
