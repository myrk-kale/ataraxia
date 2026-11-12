/**
 * The letters of ATARAXIA as thin strokes, in the style of the wordmark: geometric, with the A as
 * a bare Λ. Drawn as paths (not set in a font) so the opening can draw them line by line. All
 * numbers are in glyph units, where the capital height is 100.
 */

export type Cmd = ["M", number, number] | ["L", number, number] | ["C", number, number, number, number, number, number];

export interface Glyph {
  /** Width of the drawn letter. */
  width: number;
  /** Empty space the font keeps left and right of the letter, on top of the tracking. */
  lsb: number;
  rsb: number;
  /** Each stroke is drawn on its own, one after the other. */
  strokes: Cmd[][];
}

export const CAP = 100;
/** The space between letters before each letter's own side bearings. */
export const TRACKING = 25;
export const WORD = "ATARAXIA";

const line = (x1: number, y1: number, x2: number, y2: number): Cmd[] => [["M", x1, y1], ["L", x2, y2]];

/** The crossbar of the A, where it meets the two legs. */
const BAR_Y = 64;
const A_WIDTH = 83;
const barHalf = (A_WIDTH / 2) * (BAR_Y / CAP);

export const GLYPHS: Record<string, Glyph> = {
  A: {
    width: A_WIDTH,
    lsb: 0,
    rsb: 0,
    strokes: [
      [["M", 0, 100], ["L", A_WIDTH / 2, 0], ["L", A_WIDTH, 100]],
      line(A_WIDTH / 2 - barHalf, BAR_Y, A_WIDTH / 2 + barHalf, BAR_Y),
    ],
  },
  T: { width: 86, lsb: 0, rsb: 0, strokes: [line(0, 0, 86, 0), line(43, 0, 43, 100)] },
  R: {
    width: 62,
    lsb: 30,
    rsb: 22,
    strokes: [
      [["M", 0, 100], ["L", 0, 0], ["L", 34, 0], ["C", 62, 0, 62, 50, 34, 50], ["L", 0, 50]],
      line(30, 50, 62, 100),
    ],
  },
  X: { width: 70, lsb: 19, rsb: 0, strokes: [line(0, 0, 70, 100), line(70, 0, 0, 100)] },
  I: { width: 0, lsb: 32, rsb: 32, strokes: [line(0, 0, 0, 100)] },
};

export interface Placed {
  index: number;
  char: string;
  /** Left edge of the drawn letter, in glyph units. */
  x: number;
  glyph: Glyph;
}

/** The word laid out left to right, with the tracking and each letter's side bearings between. */
export function layout(word: string = WORD): { items: Placed[]; width: number } {
  let x = 0;
  let previous: Glyph | null = null;
  const items = [...word].map((char, index) => {
    const glyph = GLYPHS[char];
    x += previous ? previous.rsb + TRACKING + glyph.lsb : 0;
    const placed = { index, char, x, glyph };
    x += glyph.width;
    previous = glyph;
    return placed;
  });
  return { items, width: x };
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
