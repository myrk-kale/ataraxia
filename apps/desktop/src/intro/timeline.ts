import { layout, WORD, type Placement } from "./glyphs";

/**
 * The opening of the app. ATARAXIA is drawn in the middle of the window, letter by letter, each
 * letter line by line. It holds for a moment; then the other letters fade, the first A travels
 * to the corner of the header and becomes the logo, and the backdrop clears to show the
 * interface that was already rendered underneath. This file is the pure part: timing and motion.
 */

const LETTER_MS = 360;
const LETTER_STAGGER = 130;
/** When the last letter has been drawn. */
export const DRAW_END_MS = (WORD.length - 1) * LETTER_STAGGER + LETTER_MS;
export const SETTLE_START_MS = DRAW_END_MS + 330;
const SETTLE_MS = 700;
export const INTRO_MS = SETTLE_START_MS + SETTLE_MS;
const FADE_MS = 300;
const BACKDROP_FROM_MS = SETTLE_START_MS + 150;
const BACKDROP_MS = 500;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
export const easeOutCubic = (t: number) => 1 - (1 - clamp01(t)) ** 3;
export function easeInOutCubic(t: number): number {
  const u = clamp01(t);
  return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
}

/** How much of one stroke is drawn, 0 to 1. A letter's strokes follow each other. */
export function strokeProgress(elapsed: number, letter: number, stroke: number, strokes: number): number {
  const slot = LETTER_MS / strokes;
  const start = letter * LETTER_STAGGER + stroke * slot;
  return easeOutCubic((elapsed - start) / slot);
}

export interface Settle {
  /** 0 until the other letters start to fade, 1 when they are gone. */
  fade: number;
  /** How far the first A has travelled to the header, 0 to 1. */
  travel: number;
  /** Opacity of the backdrop that hides the interface. */
  backdrop: number;
  done: boolean;
}

export function settleAt(elapsed: number): Settle {
  return {
    fade: clamp01((elapsed - SETTLE_START_MS) / FADE_MS),
    travel: easeInOutCubic((elapsed - SETTLE_START_MS) / SETTLE_MS),
    backdrop: 1 - clamp01((elapsed - BACKDROP_FROM_MS) / BACKDROP_MS),
    done: elapsed >= INTRO_MS,
  };
}

export function lerpPlacement(a: Placement, b: Placement, t: number): Placement {
  return {
    ox: a.ox + (b.ox - a.ox) * t,
    oy: a.oy + (b.oy - a.oy) * t,
    s: a.s + (b.s - a.s) * t,
  };
}

/** The word centred in a window: the scale, and the left edge and top of the first letter. */
export function wordPlacement(width: number, height: number): Placement {
  const cap = Math.min(64, Math.max(26, width * 0.06));
  const s = cap / 100;
  return { ox: (width - layout().width * s) / 2, oy: height / 2 - cap / 2, s };
}

/** The opening plays every time the app opens, except for people who prefer reduced motion. */
export function introEnabled(): boolean {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
