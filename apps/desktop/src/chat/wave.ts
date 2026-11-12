/**
 * Wave interference drawn with dots, ported from the Concierge wave prototype: two point
 * sources whose rings add up, so the dot grid swells and ripples. Used by the opening splash. Pure maths plus
 * one draw function that takes any 2D context, so it can be tested without a browser.
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
  /** The brightest a dot may get (0 to 1). Defaults to the subtle 0.36 used for backgrounds. */
  ceiling?: number;
  /**
   * Reshapes each dot just before it is drawn, given its resting place and the wave's own
   * result. Return the dot to draw (any position, opacity up to the ceiling) or null to skip it.
   */
  shape?: (x: number, y: number, dot: Dot) => ShapedDot | null;
};

export type ShapedDot = { x: number; y: number; alpha: number; radius: number };

export type Dot = { alpha: number; offsetY: number; radius: number };

export function waveDot(
  x: number,
  y: number,
  width: number,
  height: number,
  t: number,
  intensity: number,
  gain: number,
): Dot {
  const strength = 0.45 + intensity * 1.45;
  const a = Math.sin(Math.hypot(x - width * 0.23, y - height * 0.42) * 0.043 - t * 0.0015);
  const b = Math.cos(Math.hypot(x - width * 0.76, y - height * 0.54) * 0.052 + t * 0.0011);
  const interference = (a + b) * 0.5;
  // Fades toward the left and right edges so the field has no hard border.
  const envelope = Math.max(0.1, 1 - Math.abs(x - width * 0.5) / (width * 0.77));
  const glow = (0.42 + 0.58 * Math.abs(interference)) * envelope;
  return {
    alpha: Math.min(MAX_ALPHA, 0.12 * glow * strength * gain),
    offsetY: interference * 3.8 * intensity,
    radius: Math.max(0.5, 0.65 + glow * 0.52),
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
  { intensity, gain, color, ceiling = MAX_ALPHA, shape }: WaveOptions,
): void {
  ctx.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0) {
    return;
  }
  const buckets: number[][] = Array.from({ length: ALPHA_STEPS + 1 }, () => []);
  for (let y = WAVE_GAP / 2; y < height; y += WAVE_GAP) {
    for (let x = WAVE_GAP / 2; x < width; x += WAVE_GAP) {
      const dot = waveDot(x, y, width, height, t, intensity, gain);
      const drawn = shape ? shape(x, y, dot) : { x, y: y + dot.offsetY, alpha: dot.alpha, radius: dot.radius };
      if (!drawn || drawn.alpha < MIN_ALPHA) {
        continue;
      }
      const step = Math.min(ALPHA_STEPS, Math.round((drawn.alpha / ceiling) * ALPHA_STEPS));
      buckets[step].push(drawn.x, drawn.y, drawn.radius);
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
    ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${((step / ALPHA_STEPS) * ceiling).toFixed(3)})`;
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
