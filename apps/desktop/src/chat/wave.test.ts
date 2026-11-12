import { describe, expect, it } from "vitest";
import { drawWaves, parseWaveColor, waveDot, WAVE_GAP, type WaveContext } from "./wave";

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
