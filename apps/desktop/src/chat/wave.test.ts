import { describe, expect, it } from "vitest";
import {
  addRipple,
  drawWaves,
  parseWaveColor,
  RIPPLE_LIFE_MS,
  waveDot,
  WAVE_GAP,
  type Ripple,
  type WaveContext,
} from "./wave";

class FakeContext implements WaveContext {
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  cleared = 0;
  fills: string[] = [];
  arcs = 0;
  clearRect() {
    this.cleared += 1;
  }
  beginPath() {}
  moveTo() {}
  arc() {
    this.arcs += 1;
  }
  fill() {
    this.fills.push(String(this.fillStyle));
  }
}

describe("waveDot", () => {
  it("keeps every dot's opacity inside the cap and its radius visible", () => {
    for (let x = 0; x < 900; x += 37) {
      for (let y = 0; y < 500; y += 41) {
        for (const t of [0, 1234, 98765]) {
          const dot = waveDot(x, y, 900, 500, t, 0.5, 3);
          expect(dot.alpha).toBeGreaterThanOrEqual(0);
          expect(dot.alpha).toBeLessThanOrEqual(0.36);
          expect(dot.radius).toBeGreaterThanOrEqual(0.5);
        }
      }
    }
  });

  it("is deterministic and moves with time", () => {
    const at = (t: number) => waveDot(300, 200, 900, 500, t, 0.5, 1);
    expect(at(500)).toEqual(at(500));
    expect(at(500)).not.toEqual(at(2500));
  });

  it("scales with gain and with intensity", () => {
    const base = waveDot(450, 250, 900, 500, 700, 0.5, 1);
    expect(waveDot(450, 250, 900, 500, 700, 0.5, 0.5).alpha).toBeLessThan(base.alpha);
    expect(waveDot(450, 250, 900, 500, 700, 0.5, 0).alpha).toBe(0);
    expect(Math.abs(waveDot(450, 250, 900, 500, 700, 1, 1).offsetY)).toBeGreaterThanOrEqual(
      Math.abs(base.offsetY),
    );
    expect(waveDot(450, 250, 900, 500, 700, 0, 1).offsetY).toBe(0);
  });

  it("fades toward the side edges", () => {
    const alphaAt = (x: number) =>
      Math.max(
        ...[0, 400, 800, 1200, 1600, 2000, 2400].map((t) => waveDot(x, 250, 900, 500, t, 0.5, 1).alpha),
      );
    expect(alphaAt(450)).toBeGreaterThan(alphaAt(5));
  });
});

describe("ripples from a click", () => {
  const click: Ripple = { x: 300, y: 200, t0: 1000 };
  const dot = (x: number, y: number, t: number, ripples: Ripple[] = [click]) =>
    waveDot(x, y, 900, 500, t, 0.5, 1, ripples);

  it("leave the field untouched when there are none or once they have died out", () => {
    const calm = dot(310, 205, 1100, []);
    expect(calm.dx).toBe(0);
    expect(calm.dy).toBe(0);
    const late = dot(310, 205, 1000 + RIPPLE_LIFE_MS + 1);
    expect(late).toEqual(dot(310, 205, 1000 + RIPPLE_LIFE_MS + 1, []));
    // A click that has not happened yet changes nothing either.
    expect(dot(310, 205, 900)).toEqual(dot(310, 205, 900, []));
  });

  it("throw nearby dots off their place, repeatably", () => {
    let moved = 0;
    for (let x = 250; x < 350; x += WAVE_GAP) {
      for (let y = 150; y < 250; y += WAVE_GAP) {
        const stirred = dot(x, y, 1200);
        expect(stirred).toEqual(dot(x, y, 1200));
        if (Math.hypot(stirred.dx, stirred.dy) > 1) {
          moved += 1;
        }
      }
    }
    expect(moved).toBeGreaterThan(20);
  });

  it("do not reach dots the shock front has not arrived at yet", () => {
    const farAway = dot(800, 450, 1050);
    expect(farAway.dx).toBe(0);
    expect(farAway.dy).toBe(0);
  });

  it("calm down as time passes", () => {
    const shake = (age: number) => {
      let total = 0;
      for (let x = 250; x < 350; x += WAVE_GAP) {
        for (let y = 150; y < 250; y += WAVE_GAP) {
          const d = dot(x, y, 1000 + age);
          total += Math.hypot(d.dx, d.dy);
        }
      }
      return total;
    };
    expect(shake(1700)).toBeLessThan(shake(300) * 0.35);
  });

  it("stay within the opacity cap and make the front swell", () => {
    for (let age = 0; age < RIPPLE_LIFE_MS; age += 150) {
      for (let x = 100; x < 600; x += 41) {
        expect(dot(x, 200, 1000 + age).alpha).toBeLessThanOrEqual(0.36);
      }
    }
    // 0.55 px/ms * 400 ms = 220 px from the click: the front is there, the middle is not.
    const onFront = dot(300 + 220, 200, 1400);
    const calm = dot(300 + 220, 200, 1400, []);
    expect(onFront.radius).toBeGreaterThan(calm.radius + 0.4);
  });

  it("are capped, and spent ones are dropped when a new one is added", () => {
    let list: Ripple[] = [];
    for (let i = 0; i < 10; i += 1) {
      list = addRipple(list, i, i, i * 10);
    }
    expect(list).toHaveLength(6);
    expect(list[list.length - 1]).toEqual({ x: 9, y: 9, t0: 90 });
    const fresh = addRipple(list, 1, 2, 90 + RIPPLE_LIFE_MS + 5);
    expect(fresh).toEqual([{ x: 1, y: 2, t0: 90 + RIPPLE_LIFE_MS + 5 }]);
  });

  it("are drawn by drawWaves without breaking its few-fills batching", () => {
    const ctx = new FakeContext();
    drawWaves(ctx, 650, 390, 1300, {
      intensity: 0.5,
      gain: 2,
      color: { r: 255, g: 255, b: 255 },
      ripples: [click],
    });
    expect(ctx.fills.length).toBeLessThanOrEqual(25);
    expect(ctx.arcs).toBeGreaterThan(0);
  });
});

describe("drawWaves", () => {
  const options = { intensity: 0.5, gain: 2, color: { r: 10, g: 20, b: 30 } };

  it("clears the frame and draws the whole grid in a few fills", () => {
    const ctx = new FakeContext();
    drawWaves(ctx, 650, 390, 1000, options);
    expect(ctx.cleared).toBe(1);
    const grid = Math.floor(650 / WAVE_GAP) * Math.floor(390 / WAVE_GAP);
    expect(ctx.arcs).toBeGreaterThan(grid * 0.6);
    expect(ctx.arcs).toBeLessThanOrEqual(grid + 60);
    // Dots share fills by opacity step instead of one fill per dot.
    expect(ctx.fills.length).toBeGreaterThan(1);
    expect(ctx.fills.length).toBeLessThanOrEqual(25);
  });

  it("paints in the requested colour", () => {
    const ctx = new FakeContext();
    drawWaves(ctx, 400, 300, 0, options);
    expect(ctx.fills.every((fill) => fill.startsWith("rgba(10,20,30,"))).toBe(true);
  });

  it("draws nothing when there is no gain or no room", () => {
    const silent = new FakeContext();
    drawWaves(silent, 400, 300, 0, { ...options, gain: 0 });
    expect(silent.arcs).toBe(0);
    const empty = new FakeContext();
    drawWaves(empty, 0, 0, 0, options);
    expect(empty.arcs).toBe(0);
    expect(empty.cleared).toBe(1);
  });
});

describe("parseWaveColor", () => {
  it("reads space or comma separated channels", () => {
    expect(parseWaveColor(" 190 233 161 ")).toEqual({ r: 190, g: 233, b: 161 });
    expect(parseWaveColor("57, 126, 102")).toEqual({ r: 57, g: 126, b: 102 });
  });

  it("rejects anything that is not three channels in range", () => {
    expect(parseWaveColor("")).toBeNull();
    expect(parseWaveColor("1 2")).toBeNull();
    expect(parseWaveColor("1 2 3 4")).toBeNull();
    expect(parseWaveColor("256 0 0")).toBeNull();
    expect(parseWaveColor("a b c")).toBeNull();
  });
});
