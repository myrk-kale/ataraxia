/** Directions a line can leave a cell in, as bits, so a cell's lines are one number. */
export const UP = 1;
export const RIGHT = 2;
export const DOWN = 4;
export const LEFT = 8;

export type StyleName = "rounded" | "unicode" | "double" | "heavy" | "ascii";

export const STYLE_NAMES: readonly StyleName[] = ["rounded", "unicode", "double", "heavy", "ascii"];

export const STYLE_LABELS: Record<StyleName, string> = {
  rounded: "╭─╮ All rounded",
  unicode: "┌─┐ Square",
  double: "╔═╗ Double",
  heavy: "┏━┓ Heavy",
  ascii: "+-+ Plain ASCII",
};

export interface Style {
  /** Corners of a box, and the straight pieces. */
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
  /** Corners of a rounded node. */
  rtl: string;
  rtr: string;
  rbl: string;
  rbr: string;
  /** What a cell with these lines (a number from the bits above) is drawn as. */
  junction: Record<number, string>;
}

const J = (corners: [string, string, string, string], tees: [string, string, string, string], cross: string) => ({
  [UP | RIGHT]: corners[0],
  [RIGHT | DOWN]: corners[1],
  [UP | LEFT]: corners[2],
  [DOWN | LEFT]: corners[3],
  [UP | RIGHT | DOWN]: tees[0],
  [UP | RIGHT | LEFT]: tees[1],
  [UP | DOWN | LEFT]: tees[2],
  [RIGHT | DOWN | LEFT]: tees[3],
  [UP | RIGHT | DOWN | LEFT]: cross,
});

const ARC = { rtl: "╭", rtr: "╮", rbl: "╰", rbr: "╯" };

export const STYLES: Record<StyleName, Style> = {
  rounded: {
    tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", ...ARC,
    junction: J(["╰", "╭", "╯", "╮"], ["├", "┴", "┤", "┬"], "┼"),
  },
  unicode: {
    tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", ...ARC,
    junction: J(["└", "┌", "┘", "┐"], ["├", "┴", "┤", "┬"], "┼"),
  },
  double: {
    tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", ...ARC,
    junction: J(["╚", "╔", "╝", "╗"], ["╠", "╩", "╣", "╦"], "╬"),
  },
  heavy: {
    tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃", ...ARC,
    junction: J(["┗", "┏", "┛", "┓"], ["┣", "┻", "┫", "┳"], "╋"),
  },
  ascii: {
    tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", rtl: ".", rtr: ".", rbl: "'", rbr: "'",
    junction: J(["+", "+", "+", "+"], ["+", "+", "+", "+"], "+"),
  },
};

/** The arrowheads, by the way they point. */
export const ARROWS = { right: "►", left: "◄", down: "▼", up: "▲" } as const;
export const ARROWS_ASCII = { right: ">", left: "<", down: "v", up: "^" } as const;

export const PACKET = "●";
export const PACKET_ASCII = "o";
export const CURSOR = "▌";
export const CURSOR_ASCII = "_";

/** What a cell with these lines is drawn as, for a style. A single arm is a straight piece. */
export function lineGlyph(style: Style, bits: number): string {
  const vertical = (bits & (UP | DOWN)) !== 0;
  const horizontal = (bits & (LEFT | RIGHT)) !== 0;
  if (vertical && horizontal) {
    return style.junction[bits] ?? "+";
  }
  return horizontal ? style.h : style.v;
}

/**
 * Whether a character takes one terminal cell. Wide characters (CJK, emoji) and the ones that
 * combine with another or have no width would break the grid, so a diagram holding any is
 * left to the full Mermaid renderer.
 */
export function isNarrow(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
    return false;
  }
  if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f || code === 0x200d) {
    return false;
  }
  return !(
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x1f000
  );
}

export const allNarrow = (text: string): boolean => [...text].every(isNarrow);
