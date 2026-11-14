/**
 * What a cell is drawn in. Each class is a role (an edge, text, a packet in flight) and is
 * tied to one of the app's colour tokens, so a diagram follows the theme.
 */
export const K = {
  none: 0,
  dim: 1,
  box: 2,
  text: 3,
  edge: 4,
  arrow: 5,
  bright: 6,
  active: 7,
  done: 8,
  warning: 9,
  glitch: 10,
  packet: 11,
  cursor: 12,
  ripple: 13,
} as const;

export const CLASS_COUNT = 14;

/** The token behind each class. Every one reads well on the app's panel colour in both themes. */
export const TOKEN_OF: readonly string[] = [
  "--cg-ink", // none (never drawn)
  "--cg-control", // dim: waiting, not yet reached
  "--cg-muted-strong", // box
  "--cg-ink", // text
  "--cg-muted", // edge
  "--cg-accent", // arrow
  "--cg-green", // bright: being drawn
  "--cg-amber-text", // active
  "--cg-green", // done
  "--cg-red", // warning
  "--cg-accent", // glitch
  "--cg-green", // packet
  "--cg-ink", // cursor
  "--cg-accent", // ripple
];

export type Rgb = [number, number, number];

/** A CSS colour as red, green and blue from 0 to 1: `#rgb`, `#rrggbb` or `rgb()`/`rgba()`. */
export function parseColor(text: string): Rgb | null {
  const value = text.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
    return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16) / 255) as Rgb;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((n) => Math.min(1, n / 255)) as Rgb;
  }
  return null;
}

/** The colour of every class as `[r, g, b, ...]`, from a function that resolves a token. */
export function buildPalette(resolve: (token: string) => string): Float32Array {
  const out = new Float32Array(CLASS_COUNT * 3);
  TOKEN_OF.forEach((token, at) => {
    const [r, g, b] = parseColor(resolve(token)) ?? [0.5, 0.5, 0.5];
    out.set([r, g, b], at * 3);
  });
  return out;
}
