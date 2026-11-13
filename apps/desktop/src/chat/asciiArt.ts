/**
 * The A of ATARAXIA as animated ASCII art, drawn behind the empty chat. This file is the pure
 * part: where the strokes are, how bright each character cell is at a moment, and which
 * character that brightness becomes. `AsciiMark.tsx` paints it.
 *
 * It is a motif of the product, not decoration for its own sake: the A is the logo, and the
 * opening already draws the word in ASCII, so the empty chat keeps the same voice. The motion is
 * slow on purpose (the name means calm): the stroke breathes, a light travels up the legs and
 * across the bar, and a faint field of dots drifts around it. Once the chat has begun the A rises
 * and fades away, and the field stays behind the conversation, kept faint where the messages are.
 */

/** From nothing to the densest character. Plain ASCII, so it looks the same in any monospace font. */
export const RAMP = " .:-=+*#%@";

/** The brand glyph's proportions: width over height of the A, and where its crossbar sits. */
const ASPECT = 83 / 100;
const BAR_AT = 0.64;
/** The share of the area's height the A takes. */
const FILL = 0.86;

/** How present the art is at its brightest. Text sits over it, so this is kept low (see `quiet`). */
export const MAX_ALPHA = 0.34;
/** The most the art may show behind the text of the empty state, for the contrast of that text. */
export const QUIET_ALPHA = 0.06;

export interface Point {
  x: number;
  y: number;
}

export interface Mark {
  apex: Point;
  left: Point;
  right: Point;
  /** The two ends of the crossbar, on the legs. */
  barLeft: Point;
  barRight: Point;
  /** Half the stroke width, in pixels. */
  stroke: number;
  width: number;
  height: number;
  /** 1 while the A is there, down to 0 once it has risen away. */
  presence: number;
}

/**
 * The A placed in an area: centred, as tall as `FILL` allows, and never wider than the area.
 * `lift` is how far it has risen away, 0 (in place) to 1 (gone): it climbs by half its height and
 * has faded out by four fifths of the way, so the room it took is free for words soon after.
 */
export function markFor(width: number, height: number, lift = 0): Mark {
  const tall = Math.min(height * FILL, (width * 0.92) / ASPECT);
  const wide = tall * ASPECT;
  const cx = width / 2;
  const rise = smooth(0, 1, lift) * tall * 0.5;
  const top = (height - tall) / 2 - rise;
  const base = top + tall;
  const barY = top + tall * BAR_AT;
  const half = (wide / 2) * BAR_AT;
  return {
    apex: { x: cx, y: top },
    left: { x: cx - wide / 2, y: base },
    right: { x: cx + wide / 2, y: base },
    barLeft: { x: cx - half, y: barY },
    barRight: { x: cx + half, y: barY },
    stroke: Math.max(5, tall * 0.036),
    width,
    height,
    presence: 1 - smooth(0, 0.8, lift),
  };
}

interface Nearest {
  /** Distance to the closest stroke, in pixels. */
  d: number;
  /** How far along the path of the legs the closest point is, 0 at the left foot, 1 at the right. */
  along: number;
  /** How far along the crossbar, 0 to 1, or `null` when a leg is the closest. */
  bar: number | null;
}

function toSegment(p: Point, a: Point, b: Point): { d: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return { d: Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)), t };
}

export function nearest(mark: Mark, p: Point): Nearest {
  const left = toSegment(p, mark.left, mark.apex);
  const right = toSegment(p, mark.apex, mark.right);
  const bar = toSegment(p, mark.barLeft, mark.barRight);
  if (bar.d < left.d && bar.d < right.d) {
    return { d: bar.d, along: 0.5, bar: bar.t };
  }
  return left.d <= right.d
    ? { d: left.d, along: left.t * 0.5, bar: null }
    : { d: right.d, along: 0.5 + right.t * 0.5, bar: null };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Where the cursor is, in the area's pixels; `null` when it is somewhere else. */
export type Pointer = Point | null;

/** Seconds into the animation, and the phase the still picture is drawn at. */
export const STILL_AT = 3.4;

/**
 * How bright a point of the area is, 0 to 1, at `time` seconds. The stroke is solid in its core
 * and soft at its edge, breathing slowly; a light runs along it; a faint field drifts around it
 * and keeps clear of it; the cursor lights the characters near it like a lantern.
 */
export function brightness(mark: Mark, p: Point, time: number, pointer: Pointer = null): number {
  const { d, along, bar } = nearest(mark, p);
  const breath = 1 + 0.1 * Math.sin(time * 0.7);
  const half = mark.stroke * breath;

  const here = mark.presence;
  const core = (1 - smooth(half * 0.55, half * 1.7, d)) * here;
  const halo = Math.exp(-d / (half * 3.2)) * 0.22 * here;

  // One light climbs the left leg and comes down the right (a lap every 9 seconds), and one
  // crosses the bar a little later. Both are soft bumps, not edges.
  const lap = (time / 9) % 1;
  const lapAt = bar === null ? Math.abs(((along - lap + 1.5) % 1) - 0.5) : 1;
  const barLap = ((time / 9 + 0.35) % 1) * 1.5 - 0.25;
  const barAt = bar === null ? 1 : Math.abs(bar - barLap);
  const run = bar === null ? Math.exp(-((lapAt / 0.07) ** 2)) : Math.exp(-((barAt / 0.12) ** 2));
  const pulse = run * core * 0.55;

  // A field of dots that drifts, thinned out where it would touch the A.
  const drift =
    0.5 + 0.5 * Math.sin(p.x * 0.047 + time * 0.31 + Math.sin(p.y * 0.031 - time * 0.17) * 1.8);
  const grain = 0.5 + 0.5 * Math.sin(p.x * 0.19 + p.y * 0.23 + time * 0.2);
  // The field keeps clear of the A while it is there, and fills the whole area once it is gone.
  const clear = 1 - here + here * smooth(half * 1.4, half * 5, d);
  // Without the A to look at, the field is the picture, so it is a good deal stronger. Where words
  // are, `quiet` brings it back down to the faint ceiling whatever its strength here.
  const field = clamp01((drift * 0.7 + grain * 0.3 - 0.66) / 0.34) * (0.28 + 0.3 * (1 - here)) * clear;

  let lantern = 0;
  if (pointer) {
    const r = Math.hypot(p.x - pointer.x, p.y - pointer.y);
    lantern = Math.exp(-((r / 120) ** 2)) * 0.5 * (0.35 + 0.65 * (drift * 0.6 + 0.4));
  }
  return clamp01(core * 0.62 + pulse + halo + field + lantern);
}

/** The character a brightness becomes. */
export function glyphFor(level: number): string {
  const index = Math.round(clamp01(level) * (RAMP.length - 1));
  return RAMP[index];
}

/** Half the width of the column the messages are laid out in, with room for their edges. */
export const COLUMN_HALF = 400;

/**
 * How much of the art may show at a point, as a share of `MAX_ALPHA`: 1 where nothing is written,
 * down to `QUIET_ALPHA / MAX_ALPHA` where words are. The edge is soft, so the art fades toward
 * the words instead of being cut by a box.
 *
 * With the empty state's title in the middle, the quiet part is a box around it. Once the chat has
 * begun (`lift` above 0) it is the whole height of the message column instead, and the art shows
 * at full strength only in the margins beside it. The change is made over the first part of the
 * lift, about a second, while the A is already fading: the only words on screen then are the
 * person's own message, on its opaque bubble, and the title line of the chat.
 */
export function quiet(width: number, height: number, p: Point, lift = 0): number {
  const floor = QUIET_ALPHA / MAX_ALPHA;
  const box = smooth(0, 150, Math.hypot(Math.max(0, Math.abs(p.x - width / 2) - 330), Math.max(0, Math.abs(p.y - height / 2) - 120)));
  const column = smooth(0, 160, Math.max(0, Math.abs(p.x - width / 2) - COLUMN_HALF));
  const shift = smooth(0, 0.6, lift);
  const edge = box + (column - box) * shift;
  return floor + (1 - floor) * edge;
}
