/**
 * The letters of ATARAXIA as thin strokes, in the style of the wordmark: geometric, with the A as
 * a bare Λ. Drawn as paths (not set in a font) so the opening can draw them line by line. All
 * numbers are in glyph units, where the capital height is 100.
 */

export type Cmd = ["M", number, number] | ["L", number, number] | ["C", number, number, number, number, number, number];

export interface Glyph {
  width: number;
  /** Each stroke is drawn on its own, one after the other. */
  strokes: Cmd[][];
}

export const CAP = 100;
/** 0.28em of tracking, with Avenir's capitals about 0.7em tall. */
export const TRACKING = 40;
export const WORD = "ATARAXIA";

const line = (x1: number, y1: number, x2: number, y2: number): Cmd[] => [["M", x1, y1], ["L", x2, y2]];

export const GLYPHS: Record<string, Glyph> = {
  A: { width: 60, strokes: [[["M", 0, 100], ["L", 30, 0], ["L", 60, 100]]] },
  T: { width: 56, strokes: [line(0, 0, 56, 0), line(28, 0, 28, 100)] },
  R: {
    width: 50,
    strokes: [
      [["M", 0, 100], ["L", 0, 0], ["L", 26, 0], ["C", 52, 0, 52, 52, 26, 52], ["L", 0, 52]],
      line(24, 52, 50, 100),
    ],
  },
  X: { width: 56, strokes: [line(0, 0, 56, 100), line(56, 0, 0, 100)] },
  I: { width: 0, strokes: [line(0, 0, 0, 100)] },
};

export interface Placed {
  index: number;
  char: string;
  /** Left edge in glyph units. */
  x: number;
  glyph: Glyph;
}

/** The word laid out left to right with the tracking between letters. */
export function layout(word: string = WORD): { items: Placed[]; width: number } {
  let x = 0;
  const items = [...word].map((char, index) => {
    const glyph = GLYPHS[char];
    const placed = { index, char, x, glyph };
    x += glyph.width + TRACKING;
    return placed;
  });
  return { items, width: x - TRACKING };
}

/** Where a glyph sits on screen: its top-left corner and how many pixels one unit is. */
export interface Placement {
  ox: number;
  oy: number;
  s: number;
}

/** A stroke as an SVG path in pixels. `dx` shifts the glyph inside the word, in glyph units. */
export function pathD(cmds: Cmd[], { ox, oy, s }: Placement, dx = 0): string {
  const px = (x: number) => (ox + (x + dx) * s).toFixed(2);
  const py = (y: number) => (oy + y * s).toFixed(2);
  return cmds
    .map((cmd) => {
      if (cmd[0] === "C") {
        return `C${px(cmd[1])} ${py(cmd[2])} ${px(cmd[3])} ${py(cmd[4])} ${px(cmd[5])} ${py(cmd[6])}`;
      }
      return `${cmd[0]}${px(cmd[1])} ${py(cmd[2])}`;
    })
    .join(" ");
}
