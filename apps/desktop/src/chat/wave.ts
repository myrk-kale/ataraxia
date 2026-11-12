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
  /** Pushes dots around while the pointer drags through the field. */
  field?: WaveField;
};

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

/** How many dots fit along a length, matching the draw loop below. */
function gridCount(length: number): number {
  return length > WAVE_GAP / 2 ? Math.ceil((length - WAVE_GAP / 2) / WAVE_GAP) : 0;
}

/** How far a push reaches, in pixels. */
const PUSH_RADIUS = 150;
/** Pull back toward the resting place, per frame (at 60 fps). */
const SPRING = 0.03;
/** Friction: just under critical damping, so dots settle with a faint, soft overshoot. */
const DAMPING = 0.2;
/** No dot ever strays farther than this from its place. */
const MAX_OFFSET = 70;
/** Below this the field counts as at rest. */
const REST = 0.03;

/** Weight of a push at a distance: 1 at the centre, easing smoothly to 0 at the edge. */
function falloff(distance: number): number {
  const u = 1 - distance / PUSH_RADIUS;
  return u <= 0 ? 0 : u * u * (3 - 2 * u);
}

/**
 * A grid of springs, one per dot. Dragging through it gives the dots under the pointer a push
 * along the drag; a click gives a light push outward. Each dot then eases back to its place,
 * so the motion stays soft and calms down on its own.
 */
export class WaveField {
  cols = 0;
  rows = 0;
  private dx = new Float32Array(0);
  private dy = new Float32Array(0);
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private active = false;

  /** Matches the field to the canvas; a size change starts it again from rest. */
  resize(width: number, height: number): void {
    const cols = gridCount(width);
    const rows = gridCount(height);
    if (cols === this.cols && rows === this.rows) {
      return;
    }
    this.cols = cols;
    this.rows = rows;
    const size = cols * rows;
    this.dx = new Float32Array(size);
    this.dy = new Float32Array(size);
    this.vx = new Float32Array(size);
    this.vy = new Float32Array(size);
    this.active = false;
  }

  /** Visits the dots within reach of (x, y) with their index, offset and weight. */
  private near(
    x: number,
    y: number,
    visit: (index: number, ox: number, oy: number, weight: number, distance: number) => void,
  ): void {
    const first = (value: number) => Math.max(0, Math.floor((value - PUSH_RADIUS) / WAVE_GAP));
    const last = (value: number, count: number) =>
      Math.min(count - 1, Math.ceil((value + PUSH_RADIUS) / WAVE_GAP));
    for (let row = first(y); row <= last(y, this.rows); row += 1) {
      for (let col = first(x); col <= last(x, this.cols); col += 1) {
        const ox = (col + 0.5) * WAVE_GAP - x;
        const oy = (row + 0.5) * WAVE_GAP - y;
        const distance = Math.hypot(ox, oy);
        const weight = falloff(distance);
        if (weight > 0) {
          visit(row * this.cols + col, ox, oy, weight, distance);
        }
      }
    }
  }

  /** A click: the dots around it swell gently outward, then ease back. */
  poke(x: number, y: number, strength = 2.4): void {
    this.near(x, y, (index, ox, oy, weight, distance) => {
      if (distance < 0.5) {
        return;
      }
      this.vx[index] += (ox / distance) * strength * weight;
      this.vy[index] += (oy / distance) * strength * weight;
      this.active = true;
    });
  }

  /** A drag step: the pointer moved by (mx, my) at (x, y), so the dots there go along. */
  drag(x: number, y: number, mx: number, my: number, strength = 0.14): void {
    // A fast flick is applied in short segments so no dots are skipped.
    const steps = Math.max(1, Math.ceil(Math.hypot(mx, my) / 24));
    for (let i = 0; i < steps; i += 1) {
      const px = x - mx + (mx * (i + 1)) / steps;
      const py = y - my + (my * (i + 1)) / steps;
      this.near(px, py, (index, _ox, _oy, weight) => {
        this.vx[index] += (mx / steps) * strength * weight;
        this.vy[index] += (my / steps) * strength * weight;
        this.active = true;
      });
    }
  }

  /** Moves every dot on by `ms` of time. */
  step(ms: number): void {
    if (!this.active) {
      return;
    }
    const frames = Math.min(4, Math.max(1, Math.round(ms / 16.7)));
    let moving = false;
    for (let frame = 0; frame < frames; frame += 1) {
      for (let i = 0; i < this.dx.length; i += 1) {
        this.vx[i] += -this.dx[i] * SPRING - this.vx[i] * DAMPING;
        this.vy[i] += -this.dy[i] * SPRING - this.vy[i] * DAMPING;
        this.dx[i] = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, this.dx[i] + this.vx[i]));
        this.dy[i] = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, this.dy[i] + this.vy[i]));
        if (
          Math.abs(this.dx[i]) > REST ||
          Math.abs(this.dy[i]) > REST ||
          Math.abs(this.vx[i]) > REST ||
          Math.abs(this.vy[i]) > REST
        ) {
          moving = true;
        }
      }
    }
    if (!moving) {
      this.dx.fill(0);
      this.dy.fill(0);
      this.vx.fill(0);
      this.vy.fill(0);
    }
    this.active = moving;
  }

  /** True while any dot is away from its place. */
  get stirred(): boolean {
    return this.active;
  }

  /** How far the dot at (col, row) is from its place. */
  offset(col: number, row: number): { dx: number; dy: number } {
    const index = row * this.cols + col;
    return { dx: this.dx[index] ?? 0, dy: this.dy[index] ?? 0 };
  }
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
  { intensity, gain, color, field }: WaveOptions,
): void {
  ctx.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0) {
    return;
  }
  const buckets: number[][] = Array.from({ length: ALPHA_STEPS + 1 }, () => []);
  const stirred = field?.stirred === true;
  let row = 0;
  for (let y = WAVE_GAP / 2; y < height; y += WAVE_GAP, row += 1) {
    let col = 0;
    for (let x = WAVE_GAP / 2; x < width; x += WAVE_GAP, col += 1) {
      const dot = waveDot(x, y, width, height, t, intensity, gain);
      let { alpha, radius } = dot;
      let px = x;
      let py = y + dot.offsetY;
      if (stirred && field) {
        const { dx, dy } = field.offset(col, row);
        const moved = Math.hypot(dx, dy);
        px += dx;
        py += dy;
        // Dots that are away from their place glow a little and swell, so the drag shows.
        alpha = Math.min(MAX_ALPHA, alpha + Math.min(0.12, moved * 0.005) * gain);
        radius += Math.min(0.9, moved * 0.025);
      }
      if (alpha < MIN_ALPHA) {
        continue;
      }
      const step = Math.round((alpha / MAX_ALPHA) * ALPHA_STEPS);
      buckets[step].push(px, py, radius);
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
