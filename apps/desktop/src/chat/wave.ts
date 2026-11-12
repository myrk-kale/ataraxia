/**
 * Wave interference drawn with dots, ported from the Concierge wave prototype: two point
 * sources whose rings add up, so the dot grid swells and ripples. Pure maths plus one draw
 * function that takes any 2D context, so it can be tested without a browser.
 */

export const WAVE_GAP = 13;
/** Dot opacity is rounded to this many steps so each step is filled in a single pass. */
const ALPHA_STEPS = 24;
const MAX_ALPHA = 0.36;
const MIN_ALPHA = 0.012;

export type WaveColor = { r: number; g: number; b: number };

export type WaveOptions = {
  /** How strongly the grid ripples, 0 to 1 (the prototype's slider; 0.5 by default). */
  intensity: number;
  /** Scales every dot's opacity: lower it behind text, raise it on light backgrounds. */
  gain: number;
  color: WaveColor;
  /** Clicks that are still stirring the field. */
  ripples?: readonly Ripple[];
};

export type Dot = { alpha: number; offsetY: number; radius: number; dx: number; dy: number };

/** A click that stirs the field: where it happened and when (same clock as the wave time). */
export type Ripple = { x: number; y: number; t0: number };

/** How long a click keeps disturbing the dots. */
export const RIPPLE_LIFE_MS = 1900;
/** The farthest a click reaches, in pixels. */
const RIPPLE_REACH = 420;
/** How fast the shock front travels, in pixels per millisecond. */
const RIPPLE_SPEED = 0.55;
const MAX_RIPPLES = 6;

/** Adds a ripple and drops the ones that have died out or exceed the cap. */
export function addRipple(ripples: readonly Ripple[], x: number, y: number, t: number): Ripple[] {
  const alive = ripples.filter((ripple) => t - ripple.t0 < RIPPLE_LIFE_MS);
  return [...alive, { x, y, t0: t }].slice(-MAX_RIPPLES);
}

/** A repeatable pseudo-random number in [-1, 1) for a dot at a moment. */
function noise(ix: number, iy: number, step: number, salt: number): number {
  const v = Math.sin(ix * 127.1 + iy * 311.7 + step * 74.7 + salt * 19.19) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
}

type Stir = { dx: number; dy: number; lift: number; swell: number };

/**
 * What the ripples do to one dot: it is thrown off its place while the shock front passes and
 * trembles until the disturbance calms down; the front itself glows and swells.
 */
function stir(x: number, y: number, t: number, ripples: readonly Ripple[]): Stir {
  const total: Stir = { dx: 0, dy: 0, lift: 0, swell: 0 };
  for (const ripple of ripples) {
    const age = t - ripple.t0;
    if (age < 0 || age >= RIPPLE_LIFE_MS) {
      continue;
    }
    const distance = Math.hypot(x - ripple.x, y - ripple.y);
    const front = age * RIPPLE_SPEED;
    const fade = Math.exp(-age / 650) * Math.max(0, 1 - distance / RIPPLE_REACH);
    const ring = Math.exp(-(((distance - front) / 48) ** 2)) * Math.exp(-age / 900);
    // Only what the front has already reached is shaken.
    if (distance <= front + 30 && fade > 0.004) {
      const step = Math.floor(age / 55);
      const ix = Math.round(x);
      const iy = Math.round(y);
      total.dx += noise(ix, iy, step, 1) * fade * 11;
      total.dy += noise(ix, iy, step, 2) * fade * 11;
    }
    total.lift += ring * 0.26 + fade * 0.08;
    total.swell += ring * 1.3;
  }
  return total;
}

export function waveDot(
  x: number,
  y: number,
  width: number,
  height: number,
  t: number,
  intensity: number,
  gain: number,
  ripples: readonly Ripple[] = [],
): Dot {
  const strength = 0.45 + intensity * 1.45;
  const a = Math.sin(Math.hypot(x - width * 0.23, y - height * 0.42) * 0.043 - t * 0.0015);
  const b = Math.cos(Math.hypot(x - width * 0.76, y - height * 0.54) * 0.052 + t * 0.0011);
  const interference = (a + b) * 0.5;
  // Fades toward the left and right edges so the field has no hard border.
  const envelope = Math.max(0.1, 1 - Math.abs(x - width * 0.5) / (width * 0.77));
  const glow = (0.42 + 0.58 * Math.abs(interference)) * envelope;
  const stirred = ripples.length > 0 ? stir(x, y, t, ripples) : null;
  return {
    alpha: Math.min(MAX_ALPHA, 0.12 * glow * strength * gain + (stirred ? stirred.lift * gain : 0)),
    offsetY: interference * 3.8 * intensity,
    radius: Math.max(0.5, 0.65 + glow * 0.52) + (stirred?.swell ?? 0),
    dx: stirred?.dx ?? 0,
    dy: stirred?.dy ?? 0,
  };
}

export interface WaveContext {
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
}

/** Draws one frame. Dots are grouped by opacity step, so a frame is a few dozen fills. */
export function drawWaves(
  ctx: WaveContext,
  width: number,
  height: number,
  t: number,
  { intensity, gain, color, ripples = [] }: WaveOptions,
): void {
  ctx.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0) {
    return;
  }
  const buckets: number[][] = Array.from({ length: ALPHA_STEPS + 1 }, () => []);
  for (let y = WAVE_GAP / 2; y < height; y += WAVE_GAP) {
    for (let x = WAVE_GAP / 2; x < width; x += WAVE_GAP) {
      const dot = waveDot(x, y, width, height, t, intensity, gain, ripples);
      if (dot.alpha < MIN_ALPHA) {
        continue;
      }
      const step = Math.round((dot.alpha / MAX_ALPHA) * ALPHA_STEPS);
      buckets[step].push(x + dot.dx, y + dot.offsetY + dot.dy, dot.radius);
    }
  }
  buckets.forEach((dots, step) => {
    if (dots.length === 0) {
      return;
    }
    ctx.beginPath();
    for (let i = 0; i < dots.length; i += 3) {
      ctx.moveTo(dots[i] + dots[i + 2], dots[i + 1]);
      ctx.arc(dots[i], dots[i + 1], dots[i + 2], 0, Math.PI * 2);
    }
    ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${((step / ALPHA_STEPS) * MAX_ALPHA).toFixed(3)})`;
    ctx.fill();
  });
}

/** Reads a `r g b` custom property such as `190 233 161`; null when it is missing or invalid. */
export function parseWaveColor(value: string): WaveColor | null {
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
    return null;
  }
  return { r: parts[0], g: parts[1], b: parts[2] };
}
