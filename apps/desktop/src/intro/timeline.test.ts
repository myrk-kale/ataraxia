import { describe, expect, it } from "vitest";
import {
  frameAt,
  horizontal,
  IMPRINT_MS,
  lambda,
  markIn,
  MARK_BOX,
  pointAlong,
  segmentShape,
  stampSegments,
} from "./timeline";

describe("the mark", () => {
  it("is a lambda: apex above, feet on either side of it", () => {
    const [left, apex, right] = lambda(500, 300);
    expect(apex.x).toBe(500);
    expect(apex.y).toBeLessThan(left.y);
    expect(left.x).toBeLessThan(apex.x);
    expect(right.x).toBeGreaterThan(apex.x);
    expect(left.y).toBe(right.y);
  });

  it("walks along its length with the apex at the half", () => {
    const shape = lambda(500, 300);
    expect(pointAlong(shape, 0)).toEqual(shape[0]);
    expect(pointAlong(shape, 0.5)).toEqual(shape[1]);
    expect(pointAlong(shape, 1)).toEqual(shape[2]);
  });

  it("breaks into three separate pieces: left leg, apex, right leg", () => {
    const [a, b, c] = stampSegments(500, 300);
    expect(a[0]).toEqual(lambda(500, 300)[0]);
    expect(c[2]).toEqual(lambda(500, 300)[2]);
    expect(b[1]).toEqual(lambda(500, 300)[1]);
    // Left to right, with room between pieces.
    expect(a[2].x).toBeLessThan(b[0].x);
    expect(b[2].x).toBeLessThan(c[0].x);
  });

  it("lands on the header mark's own shape", () => {
    const rect = { left: 29, top: 24, width: MARK_BOX.width, height: MARK_BOX.height };
    const [foot, apex, other] = markIn(rect);
    expect(apex.x).toBeCloseTo(29 + 8);
    expect(apex.y).toBeLessThan(foot.y);
    expect(other.x).toBeGreaterThan(apex.x);
  });
});

describe("timing", () => {
  it("takes 1.1 seconds", () => {
    expect(IMPRINT_MS).toBe(1100);
  });

  it("stamps first, then travels, and hides the interface until the pieces are moving", () => {
    const start = frameAt(0);
    expect(start.draw).toEqual([0, 0, 0]);
    expect(start.travel).toEqual([0, 0, 0]);
    expect(start.backdrop).toBe(1);
    const held = frameAt(540);
    expect(held.draw).toEqual([1, 1, 1]);
    expect(held.travel).toEqual([0, 0, 0]);
    expect(held.backdrop).toBe(1);
    const moving = frameAt(800);
    moving.travel.forEach((t) => {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1);
    });
    expect(moving.backdrop).toBeLessThan(1);
    expect(moving.backdrop).toBeGreaterThan(0);
  });

  it("has everything in place and the backdrop gone before the end", () => {
    const last = frameAt(IMPRINT_MS - 1);
    expect(last.travel).toEqual([1, 1, 1]);
    expect(last.backdrop).toBe(0);
    expect(last.done).toBe(false);
    expect(frameAt(IMPRINT_MS).done).toBe(true);
  });

  it("never goes backwards", () => {
    let before = frameAt(0);
    for (let t = 10; t <= IMPRINT_MS; t += 10) {
      const now = frameAt(t);
      now.travel.forEach((value, i) => expect(value).toBeGreaterThanOrEqual(before.travel[i]));
      now.draw.forEach((value, i) => expect(value).toBeGreaterThanOrEqual(before.draw[i]));
      expect(now.backdrop).toBeLessThanOrEqual(before.backdrop);
      before = now;
    }
  });
});

describe("segmentShape", () => {
  const [piece] = stampSegments(500, 300);
  const target = horizontal(0, 1000, 60.5);

  it("starts as a point, grows into its piece, then travels to the target exactly", () => {
    const start = segmentShape(piece, target, 0, 0);
    expect(start[0]).toEqual(start[2]);
    expect(segmentShape(piece, target, 1, 0)).toEqual(piece);
    expect(segmentShape(piece, target, 1, 1)).toEqual(target);
  });
});
