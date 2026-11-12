import type { Dot, ShapedDot } from "./wave";

/** The whole opening, in ms. */
export const INTRO_MS = 1900;
/** When the interface starts to open up through the waves. */
export const REVEAL_START_MS = 950;
/** The waves spread out from the centre at this speed (px per ms), then pulse outward. */
const BLOOM_SPEED = 1.7;
const RING_COUNT = 3;
const RING_GAP_MS = 230;
const RING_SPEED = 0.95;
const RING_WIDTH = 70;
/** How wide the bright crest at the edge of the opening is. */
const CREST_WIDTH = 120;
/** The brightest a dot gets during the opening. */
export const INTRO_CEILING = 0.85;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function easeInOutCubic(t: number): number {
  const u = clamp01(t);
  return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
}

/** Radius of the opening through which the interface shows; 0 until the reveal starts. */
export function revealRadius(elapsed: number, width: number, height: number): number {
  const progress = clamp01((elapsed - REVEAL_START_MS) / (INTRO_MS - REVEAL_START_MS));
  // Just past the corners, so the last dot is gone when the intro ends.
  return easeInOutCubic(progress) * (Math.hypot(width, height) / 2 + 2);
}

/**
 * The look of the opening, as a function of time. The dots bloom out of the centre, shock
 * rings run through them (bigger, brighter, pushed outward) and then the interface opens up as
 * a circle that grows to the corners, with a bright crest of dots riding its edge.
 */
export function introShape(
  elapsed: number,
  width: number,
  height: number,
): (x: number, y: number, dot: Dot) => ShapedDot | null {
  const cx = width / 2;
  const cy = height / 2;
  const bloom = elapsed * BLOOM_SPEED;
  const open = revealRadius(elapsed, width, height);
  const fadeIn = clamp01(elapsed / 350);
  return (x, y, dot) => {
    const dx = x - cx;
    const dy = y - cy;
    const distance = Math.hypot(dx, dy);
    if (distance > bloom || distance < open) {
      return null;
    }
    let lift = 0;
    for (let ring = 0; ring < RING_COUNT; ring += 1) {
      const age = elapsed - ring * RING_GAP_MS;
      if (age <= 0) {
        continue;
      }
      const away = Math.abs(distance - age * RING_SPEED) / RING_WIDTH;
      if (away < 1) {
        lift += (1 - away) ** 2 * Math.exp(-age / 900);
      }
    }
    // The crest at the front of the bloom and at the rim of the opening.
    const front = clamp01(1 - (bloom - distance) / 90);
    const rim = open > 0 ? clamp01(1 - (distance - open) / CREST_WIDTH) : 0;
    const crest = Math.min(1.4, lift + front * front * 0.8 + rim * rim * 1.4);
    const push = crest * 16;
    const norm = distance || 1;
    return {
      x: x + (dx / norm) * push,
      y: y + dot.offsetY + (dy / norm) * push,
      alpha: Math.min(INTRO_CEILING, (dot.alpha + crest * 0.5) * fadeIn),
      radius: dot.radius + crest * 2.6,
    };
  };
}
