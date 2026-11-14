import { describe, expect, it } from "vitest";
import { clampPan, fitZoom, maxZoomFor, zoomAround } from "./viewport";

const drawing = { width: 800, height: 400 };

describe("fitZoom", () => {
  it("fits the drawing in the window with room round it", () => {
    const zoom = fitZoom(drawing, { width: 1064, height: 864 }, 8);
    expect(drawing.width * zoom).toBeCloseTo(1000);
    expect(drawing.height * zoom).toBeLessThanOrEqual(800);
  });

  it("is limited by the tighter of width and height", () => {
    const zoom = fitZoom({ width: 100, height: 1000 }, { width: 2000, height: 564 }, 8);
    expect(1000 * zoom).toBeCloseTo(500);
  });

  it("never goes past the most the drawing can be zoomed", () => {
    expect(fitZoom({ width: 10, height: 10 }, { width: 2000, height: 2000 }, 3)).toBe(3);
  });

  it("is 1 before the window has a size", () => {
    expect(fitZoom(drawing, { width: 0, height: 0 }, 8)).toBe(1);
  });
});

describe("maxZoomFor", () => {
  it("keeps the canvas within what the card can draw, on a screen with twice the pixels", () => {
    const max = maxZoomFor(drawing, 2, 8192);
    expect(drawing.width * max * 2).toBeLessThanOrEqual(8192 + 1e-6);
  });

  it("stops a big diagram sooner than a small one", () => {
    expect(maxZoomFor({ width: 2000, height: 1000 }, 2, 8192)).toBeLessThan(maxZoomFor({ width: 200, height: 100 }, 2, 8192));
  });

  it("keeps the area of the canvas bounded", () => {
    const max = maxZoomFor({ width: 1500, height: 1500 }, 2, 16384, 16_000_000);
    expect(1500 * max * 2 * (1500 * max * 2)).toBeLessThanOrEqual(16_000_000 * 1.001);
  });

  it("is at most 8, and at least a quarter", () => {
    expect(maxZoomFor({ width: 10, height: 10 }, 1, 16384)).toBe(8);
    expect(maxZoomFor({ width: 100000, height: 100000 }, 2, 4096)).toBe(0.25);
  });
});

describe("zoomAround", () => {
  it("keeps the point of the drawing under the pointer where it is", () => {
    const at = { x: 40, y: 20 };
    const point = { x: 300, y: 200 };
    const from = 1;
    const to = 2.5;
    const next = zoomAround(at, from, to, point);
    // The point of the drawing under the pointer, before and after.
    const before = { x: (point.x - at.x) / from, y: (point.y - at.y) / from };
    const after = { x: (point.x - next.x) / to, y: (point.y - next.y) / to };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("leaves the drawing where it is when the zoom does not change", () => {
    expect(zoomAround({ x: 10, y: 20 }, 2, 2, { x: 99, y: 99 })).toEqual({ x: 10, y: 20 });
  });

  it("zooming about the corner of the drawing keeps the corner", () => {
    expect(zoomAround({ x: 50, y: 60 }, 1, 3, { x: 50, y: 60 })).toEqual({ x: 50, y: 60 });
  });
});

describe("clampPan", () => {
  const window = { width: 1000, height: 600 };

  it("lets a drawing bigger than the window move, but keeps some of it in view", () => {
    const big = { width: 3000, height: 2000 };
    expect(clampPan({ x: 5000, y: 5000 }, big, window)).toEqual({ x: 920, y: 520 });
    expect(clampPan({ x: -9000, y: -9000 }, big, window)).toEqual({ x: 80 - 3000, y: 80 - 2000 });
  });

  it("leaves a position that is already fine alone", () => {
    expect(clampPan({ x: -300, y: -100 }, { width: 3000, height: 2000 }, window)).toEqual({ x: -300, y: -100 });
  });

  it("keeps a drawing smaller than the window inside it", () => {
    const small = { width: 400, height: 200 };
    expect(clampPan({ x: -50, y: 900 }, small, window)).toEqual({ x: 0, y: 400 });
    expect(clampPan({ x: 300, y: 100 }, small, window)).toEqual({ x: 300, y: 100 });
  });
});
