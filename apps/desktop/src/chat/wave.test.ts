import { describe, expect, it } from "vitest";
import { drawWaves, parseWaveColor, waveDot, WaveField, WAVE_GAP, type WaveContext } from "./wave";

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
  arc(_x?: number, _y?: number) {
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

/** Where the dot in a column and row sits at rest. */
const rest = (col: number, row: number) => ({ x: (col + 0.5) * WAVE_GAP, y: (row + 0.5) * WAVE_GAP });

function field(width = 650, height = 390): WaveField {
  const f = new WaveField();
  f.resize(width, height);
  return f;
}

/** The largest distance any dot is from its place. */
function spread(f: WaveField): number {
  let most = 0;
  for (let row = 0; row < f.rows; row += 1) {
    for (let col = 0; col < f.cols; col += 1) {
      const { dx, dy } = f.offset(col, row);
      most = Math.max(most, Math.hypot(dx, dy));
    }
  }
  return most;
}

function run(f: WaveField, frames: number) {
  for (let i = 0; i < frames; i += 1) {
    f.step(16.7);
  }
}

describe("WaveField", () => {
  it("matches the dot grid the draw loop walks", () => {
    for (const [w, h] of [[650, 390], [13, 13], [19.5, 26], [1565, 784]] as const) {
      const f = field(w, h);
      let cols = 0;
      for (let x = WAVE_GAP / 2; x < w; x += WAVE_GAP) cols += 1;
      let rows = 0;
      for (let y = WAVE_GAP / 2; y < h; y += WAVE_GAP) rows += 1;
      expect([f.cols, f.rows]).toEqual([cols, rows]);
    }
    expect(field(0, 0).cols).toBe(0);
  });

  it("starts at rest", () => {
    const f = field();
    expect(f.stirred).toBe(false);
    expect(spread(f)).toBe(0);
    f.step(16.7);
    expect(spread(f)).toBe(0);
  });

  it("moves the dots under a drag along the drag, and leaves faraway ones alone", () => {
    const f = field();
    const centre = rest(25, 15);
    f.drag(centre.x, centre.y, 30, 0);
    run(f, 6);
    const near = f.offset(25, 15);
    expect(near.dx).toBeGreaterThan(1);
    expect(Math.abs(near.dy)).toBeLessThan(near.dx * 0.2);
    const far = f.offset(2, 2);
    expect(far.dx).toBe(0);
    expect(far.dy).toBe(0);
  });

  it("pushes the dots in the direction of a drag, whichever way it goes", () => {
    const f = field();
    const c = rest(20, 12);
    f.drag(c.x, c.y, -18, 24);
    run(f, 5);
    const { dx, dy } = f.offset(20, 12);
    expect(dx).toBeLessThan(0);
    expect(dy).toBeGreaterThan(0);
  });

  it("shifts dots less the farther they are from the pointer", () => {
    const f = field();
    const c = rest(25, 15);
    f.drag(c.x, c.y, 30, 0);
    run(f, 6);
    const at = (cols: number) => Math.abs(f.offset(25 + cols, 15).dx);
    expect(at(0)).toBeGreaterThan(at(4));
    expect(at(4)).toBeGreaterThan(at(8));
  });

  it("gives a plain click a light push outward from where it landed", () => {
    const f = field();
    const c = rest(25, 15);
    f.poke(c.x, c.y);
    run(f, 6);
    expect(f.offset(28, 15).dx).toBeGreaterThan(0.5);
    expect(f.offset(22, 15).dx).toBeLessThan(-0.5);
    expect(f.offset(25, 18).dy).toBeGreaterThan(0.5);
    expect(f.offset(25, 12).dy).toBeLessThan(-0.5);
  });

  it("eases back to rest by itself, softly", () => {
    const f = field();
    const c = rest(25, 15);
    f.drag(c.x, c.y, 40, 20);
    run(f, 4);
    const peak = spread(f);
    expect(peak).toBeGreaterThan(3);
    run(f, 150);
    expect(spread(f)).toBeLessThan(peak * 0.02);
    run(f, 400);
    expect(spread(f)).toBe(0);
    expect(f.stirred).toBe(false);
  });

  it("never lets a dot stray far, however hard it is pushed", () => {
    const f = field();
    const c = rest(25, 15);
    for (let i = 0; i < 200; i += 1) {
      f.drag(c.x, c.y, 60, 60);
      f.poke(c.x, c.y, 20);
      f.step(16.7);
      expect(Number.isFinite(spread(f))).toBe(true);
    }
    expect(spread(f)).toBeLessThanOrEqual(Math.SQRT2 * 70 + 0.01);
  });

  it("takes a fast flick as a series of short pushes so nothing is skipped", () => {
    const f = field();
    const start = rest(5, 15);
    f.drag(start.x + 400, start.y, 400, 0);
    run(f, 5);
    // Dots all along the flick were carried, not only the ones at its end.
    expect(f.offset(10, 15).dx).toBeGreaterThan(0.5);
    expect(f.offset(20, 15).dx).toBeGreaterThan(0.5);
    expect(f.offset(30, 15).dx).toBeGreaterThan(0.5);
  });

  it("starts again from rest when the canvas changes size", () => {
    const f = field();
    const c = rest(10, 10);
    f.drag(c.x, c.y, 30, 30);
    run(f, 3);
    expect(spread(f)).toBeGreaterThan(0);
    f.resize(900, 500);
    expect(spread(f)).toBe(0);
    expect(f.stirred).toBe(false);
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

  it("draws dots where a drag moved them, still in a few fills", () => {
    class Recording extends FakeContext {
      points: Array<[number, number]> = [];
      arc(x: number, y: number) {
        super.arc(x, y);
        this.points.push([x, y]);
      }
    }
    const still = new Recording();
    drawWaves(still, 650, 390, 500, options);

    const f = field();
    const c = rest(25, 15);
    f.drag(c.x, c.y, 30, 0);
    run(f, 6);
    const dragged = new Recording();
    drawWaves(dragged, 650, 390, 500, { ...options, field: f });

    expect(dragged.fills.length).toBeLessThanOrEqual(25);
    // Some dots are somewhere else than they were without the drag...
    const home = new Set(still.points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`));
    const away = dragged.points.filter(([x, y]) => !home.has(`${x.toFixed(1)},${y.toFixed(1)}`));
    expect(away.length).toBeGreaterThan(20);
    // ...and a field that is not stirred changes nothing.
    const calm = new Recording();
    drawWaves(calm, 650, 390, 500, { ...options, field: field() });
    expect(calm.points).toEqual(still.points);
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
