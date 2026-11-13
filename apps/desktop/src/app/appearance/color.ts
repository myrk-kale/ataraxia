/** Colour arithmetic for themes: parsing, blending and the contrast guarantees the interface keeps. */

export type Rgb = { r: number; g: number; b: number };
export type Rgba = Rgb & { a: number };

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`; anything else (named colours, functions) is not a theme colour. */
export function parseColor(text: unknown): Rgba | null {
  if (typeof text !== "string") {
    return null;
  }
  const value = text.trim();
  if (!HEX.test(value)) {
    return null;
  }
  let hex = value.slice(1);
  if (hex.length <= 4) {
    hex = [...hex].map((digit) => digit + digit).join("");
  }
  const n = (at: number) => parseInt(hex.slice(at, at + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
}

const two = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");

export function toHex(color: Rgb): string {
  return `#${two(color.r)}${two(color.g)}${two(color.b)}`;
}

/** The colour as seen when it is laid over an opaque background. */
export function over(color: Rgba, background: Rgb): Rgb {
  return {
    r: color.r * color.a + background.r * (1 - color.a),
    g: color.g * color.a + background.g * (1 - color.a),
    b: color.b * color.a + background.b * (1 - color.a),
  };
}

/** `from` toward `to` by `amount` (0 to 1), opaque. */
export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(color: Rgb): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

export const WHITE: Rgb = { r: 255, g: 255, b: 255 };
export const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** The most readable of black and white on a background. */
export function readableOn(background: Rgb): Rgb {
  return contrast(WHITE, background) >= contrast(BLACK, background) ? WHITE : BLACK;
}

/**
 * The colour itself when it already reads at `minimum` against every background given, otherwise
 * the closest colour that does, moved toward white or black (whichever is further from them).
 * Imported themes are written for an editor; the interface around it must stay legible.
 */
export function ensureContrast(color: Rgb, backgrounds: Rgb | Rgb[], minimum: number): Rgb {
  const list = Array.isArray(backgrounds) ? backgrounds : [backgrounds];
  // The colour ends up as an 8-bit hex, so the floor is checked on the colour that will be painted.
  const snap = (value: Rgb): Rgb => ({ r: Math.round(value.r), g: Math.round(value.g), b: Math.round(value.b) });
  const worst = (candidate: Rgb) => Math.min(...list.map((background) => contrast(snap(candidate), background)));
  if (worst(color) >= minimum) {
    return snap(color);
  }
  const average = list.reduce((sum, item) => sum + luminance(item), 0) / list.length;
  const target = average > 0.4 ? BLACK : WHITE;
  for (let step = 1; step <= 40; step += 1) {
    const candidate = mix(color, target, step / 40);
    if (worst(candidate) >= minimum) {
      return snap(candidate);
    }
  }
  return target;
}
