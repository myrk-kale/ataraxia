/**
 * "The Imprint", the opening of the app (1.1 s). The brand mark, a Λ, is stamped small in the
 * middle of the window in thin monochrome strokes. It does not grow: it comes apart into three
 * segments that travel to real parts of the interface (the header rule, the composer, the
 * brand mark in the header) while the backdrop fades, so the mark becomes the interface and
 * there is no cut between the animation and the product. This file is the pure part: geometry
 * and timing.
 */

export type Point = { x: number; y: number };
/** Every shape is a polyline of three points, so any one can morph into any other. */
export type Poly = [Point, Point, Point];

export const IMPRINT_MS = 1100;

/** The mark in the header, in its own units. The animation lands on exactly this shape. */
export const MARK_BOX = { width: 16, height: 14 };
export const MARK_POINTS: [number, number][] = [
  [2, 12.5],
  [8, 1.5],
  [14, 12.5],
];

/** The mark as stamped at the start of the animation, in pixels. */
const STAMP_WIDTH = 56;
const STAMP_HEIGHT = 48;
/** How much of the mark's length is left open between segments. */
const GAP = 0.024;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
export const easeOutCubic = (t: number) => 1 - (1 - clamp01(t)) ** 3;
export function easeInOutCubic(t: number): number {
  const u = clamp01(t);
  return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpPoint = (a: Point, b: Point, t: number): Point => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});

export function lerpPoly(a: Poly, b: Poly, t: number): Poly {
  return [lerpPoint(a[0], b[0], t), lerpPoint(a[1], b[1], t), lerpPoint(a[2], b[2], t)];
}

/** The Λ centred on (cx, cy): foot, apex, foot. */
export function lambda(cx: number, cy: number): Poly {
  return [
    { x: cx - STAMP_WIDTH / 2, y: cy + STAMP_HEIGHT / 2 },
    { x: cx, y: cy - STAMP_HEIGHT / 2 },
    { x: cx + STAMP_WIDTH / 2, y: cy + STAMP_HEIGHT / 2 },
  ];
}

/** The point at a fraction (0 to 1) of the way along the Λ's length, apex at one half. */
export function pointAlong(shape: Poly, fraction: number): Point {
  const f = clamp01(fraction);
  return f < 0.5
    ? lerpPoint(shape[0], shape[1], f * 2)
    : lerpPoint(shape[1], shape[2], (f - 0.5) * 2);
}

/** The three pieces of the Λ: left leg, the apex, right leg, with small gaps between. */
export function stampSegments(cx: number, cy: number): [Poly, Poly, Poly] {
  const shape = lambda(cx, cy);
  const cut = (from: number, to: number, middle = (from + to) / 2): Poly => [
    pointAlong(shape, from),
    pointAlong(shape, middle),
    pointAlong(shape, to),
  ];
  return [
    cut(0, 1 / 3 - GAP),
    cut(1 / 3 + GAP, 2 / 3 - GAP, 0.5),
    cut(2 / 3 + GAP, 1),
  ];
}

export type Frame = {
  /** How much of each segment has been stamped, 0 to 1. */
  draw: [number, number, number];
  /** How far each segment has travelled to its place in the interface, 0 to 1. */
  travel: [number, number, number];
  /** Opacity of the backdrop that hides the interface. */
  backdrop: number;
  done: boolean;
};

const STAMP_AT = 100;
const STAMP_STAGGER = 70;
const STAMP_MS = 260;
const TRAVEL_AT = 560;
const TRAVEL_STAGGER = 50;
const TRAVEL_MS = 390;
const BACKDROP_FADE_AT = 600;
const BACKDROP_FADE_MS = 340;

export function frameAt(elapsed: number): Frame {
  const at = (index: number, start: number, stagger: number, length: number) =>
    clamp01((elapsed - (start + index * stagger)) / length);
  return {
    draw: [0, 1, 2].map((i) => easeOutCubic(at(i, STAMP_AT, STAMP_STAGGER, STAMP_MS))) as Frame["draw"],
    travel: [0, 1, 2].map((i) => easeInOutCubic(at(i, TRAVEL_AT, TRAVEL_STAGGER, TRAVEL_MS))) as Frame["travel"],
    backdrop: 1 - clamp01((elapsed - BACKDROP_FADE_AT) / BACKDROP_FADE_MS),
    done: elapsed >= IMPRINT_MS,
  };
}

/** A segment's shape: stamped from a point into its piece of the Λ, then moved to its target. */
export function segmentShape(piece: Poly, target: Poly, draw: number, travel: number): Poly {
  const stamped = lerpPoly([piece[0], piece[0], piece[0]], piece, draw);
  return lerpPoly(stamped, target, travel);
}

/** A straight line from (x1, y) to (x2, y), as a polyline. */
export function horizontal(x1: number, x2: number, y: number): Poly {
  return [
    { x: x1, y },
    { x: (x1 + x2) / 2, y },
    { x: x2, y },
  ];
}

/** The mark of the header, placed in a box on screen. */
export function markIn(rect: { left: number; top: number; width: number; height: number }): Poly {
  const place = ([x, y]: [number, number]): Point => ({
    x: rect.left + (x / MARK_BOX.width) * rect.width,
    y: rect.top + (y / MARK_BOX.height) * rect.height,
  });
  return [place(MARK_POINTS[0]), place(MARK_POINTS[1]), place(MARK_POINTS[2])];
}

export function polyPoints(shape: Poly): string {
  return shape.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

export function introEnabled(): boolean {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
