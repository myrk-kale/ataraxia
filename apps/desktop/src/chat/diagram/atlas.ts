/**
 * Draws one character into a cell of the glyph atlas, in white on transparent (the card
 * colours it). Lines, corners, arrowheads and the other marks the diagrams use are drawn
 * here from geometry, not taken from a font: they then meet the next cell exactly at any
 * size and on any screen, and no font has to have them. Letters come from the app's own
 * monospace font.
 */

type Arms = readonly [up: number, right: number, down: number, left: number];

interface Line {
  arms: Arms;
  /** 1 light, 2 heavy, 3 double. */
  weight: 1 | 2 | 3;
  round: boolean;
}

const LINES = new Map<string, Line>();

function addLines(weight: 1 | 2 | 3, entries: [string, Arms][], round = false) {
  for (const [char, arms] of entries) {
    LINES.set(char, { arms, weight, round });
  }
}

// [up, right, down, left]: 1 where the line leaves the cell on that side.
const SHAPES = (set: string): [string, Arms][] => {
  const arms: Arms[] = [
    [0, 1, 0, 1],
    [1, 0, 1, 0],
    [0, 1, 1, 0],
    [0, 0, 1, 1],
    [1, 1, 0, 0],
    [1, 0, 0, 1],
    [1, 1, 1, 0],
    [1, 0, 1, 1],
    [0, 1, 1, 1],
    [1, 1, 0, 1],
    [1, 1, 1, 1],
  ];
  return [...set].map((char, at) => [char, arms[at]!]);
};

addLines(1, SHAPES("─│┌┐└┘├┤┬┴┼"));
addLines(2, SHAPES("━┃┏┓┗┛┣┫┳┻╋"));
addLines(3, SHAPES("═║╔╗╚╝╠╣╦╩╬"));
addLines(
  1,
  [
    ["╭", [0, 1, 1, 0]],
    ["╮", [0, 0, 1, 1]],
    ["╰", [1, 1, 0, 0]],
    ["╯", [1, 0, 0, 1]],
  ],
  true,
);

/** Quadrant blocks: which of upper-left, upper-right, lower-left, lower-right are filled. */
const QUADRANTS: Record<string, number> = {
  "▖": 4,
  "▘": 1,
  "▝": 2,
  "▗": 8,
  "▚": 1 | 8,
  "▞": 2 | 4,
  "▛": 1 | 2 | 4,
  "▜": 1 | 2 | 8,
  "▙": 1 | 4 | 8,
  "▟": 2 | 4 | 8,
};

export interface Cell {
  /** Top-left of the cell in the atlas, and its size, in device pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  dpr: number;
  font: string;
}

function drawLine(ctx: CanvasRenderingContext2D, line: Line, { x, y, w, h, dpr }: Cell) {
  const light = Math.max(1, Math.round(dpr * 1.1));
  const width = line.weight === 1 ? light : line.weight === 2 ? light * 2 : light * 3;
  const top = y + Math.floor((h - width) / 2);
  const left = x + Math.floor((w - width) / 2);
  const [up, right, down, leftArm] = line.arms;
  const centre = (size: number, at: number, total: number) => at + Math.floor((total - size) / 2);
  const arms = (size: number, erase: boolean) => {
    const t = centre(size, y, h);
    const l = centre(size, x, w);
    const fill = erase ? ctx.clearRect.bind(ctx) : ctx.fillRect.bind(ctx);
    if (right) fill(l, t, x + w - l, size);
    if (leftArm) fill(x, t, l + size - x, size);
    if (down) fill(l, t, size, y + h - t);
    if (up) fill(l, y, size, t + size - y);
  };
  ctx.fillStyle = "#fff";
  if (line.round) {
    const radius = Math.min(h / 2, w * 0.75);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = width;
    ctx.beginPath();
    const cx = left + width / 2;
    const cy = top + width / 2;
    const horizontalEdge = right ? x + w : x;
    const verticalEdge = down ? y + h : y;
    const sy = down ? 1 : -1;
    ctx.moveTo(horizontalEdge, cy);
    ctx.quadraticCurveTo(cx, cy, cx, cy + sy * radius);
    ctx.lineTo(cx, verticalEdge);
    ctx.stroke();
    return;
  }
  arms(width, false);
  if (line.weight === 3) {
    // A double line is a thick one with a thin one cleared out of its middle.
    arms(light, true);
  }
}

function polygon(ctx: CanvasRenderingContext2D, points: [number, number][]) {
  ctx.beginPath();
  points.forEach(([px, py], at) => (at === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
  ctx.closePath();
  ctx.fill();
}

/** Returns true when the character is one of the drawn marks, false when it is a letter. */
function drawMark(ctx: CanvasRenderingContext2D, char: string, cell: Cell): boolean {
  const { x, y, w, h, dpr } = cell;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const lw = Math.max(1, Math.round(dpr * 1.1));
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = lw;
  const line = LINES.get(char);
  if (line) {
    drawLine(ctx, line, cell);
    return true;
  }
  const quadrants = QUADRANTS[char];
  if (quadrants) {
    const hw = Math.floor(w / 2);
    const hh = Math.floor(h / 2);
    if (quadrants & 1) ctx.fillRect(x, y, hw, hh);
    if (quadrants & 2) ctx.fillRect(x + hw, y, w - hw, hh);
    if (quadrants & 4) ctx.fillRect(x, y + hh, hw, h - hh);
    if (quadrants & 8) ctx.fillRect(x + hw, y + hh, w - hw, h - hh);
    return true;
  }
  switch (char) {
    case "►":
      polygon(ctx, [[x + w * 0.18, cy - h * 0.26], [x + w * 0.95, cy], [x + w * 0.18, cy + h * 0.26]]);
      return true;
    case "◄":
      polygon(ctx, [[x + w * 0.82, cy - h * 0.26], [x + w * 0.05, cy], [x + w * 0.82, cy + h * 0.26]]);
      return true;
    case "▼":
      polygon(ctx, [[cx - w * 0.42, y + h * 0.3], [cx + w * 0.42, y + h * 0.3], [cx, y + h * 0.78]]);
      return true;
    case "▲":
      polygon(ctx, [[cx - w * 0.42, y + h * 0.7], [cx + w * 0.42, y + h * 0.7], [cx, y + h * 0.22]]);
      return true;
    case "●":
    case "○":
    case "◐": {
      // A status mark sits at the left of its cell, so it does not touch the name beside it.
      const mx = char === "●" ? cx : cx - w * 0.16;
      ctx.beginPath();
      ctx.arc(mx, cy, w * (char === "●" ? 0.36 : 0.32), 0, Math.PI * 2);
      if (char === "●") {
        ctx.fill();
      } else {
        ctx.stroke();
      }
      if (char === "◐") {
        ctx.beginPath();
        ctx.arc(mx, cy, w * 0.32, Math.PI / 2, (3 * Math.PI) / 2);
        ctx.fill();
      }
      return true;
    }
    case "◆":
      polygon(ctx, [[cx, cy - h * 0.28], [cx + w * 0.4, cy], [cx, cy + h * 0.28], [cx - w * 0.4, cy]]);
      return true;
    case "✓":
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.46, cy);
      ctx.lineTo(cx - w * 0.22, cy + h * 0.2);
      ctx.lineTo(cx + w * 0.22, cy - h * 0.22);
      ctx.stroke();
      return true;
    case "✗":
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.46, cy - h * 0.2);
      ctx.lineTo(cx + w * 0.14, cy + h * 0.2);
      ctx.moveTo(cx + w * 0.14, cy - h * 0.2);
      ctx.lineTo(cx - w * 0.46, cy + h * 0.2);
      ctx.stroke();
      return true;
    case "▌":
      ctx.fillRect(x, y, Math.floor(w / 2), h);
      return true;
    case "░":
    case "▒":
    case "▓":
      ctx.globalAlpha = char === "░" ? 0.25 : char === "▒" ? 0.5 : 0.75;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      return true;
    default:
      return false;
  }
}

/** Draws `char` into its cell of the atlas. */
export function drawGlyph(ctx: CanvasRenderingContext2D, char: string, cell: Cell) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(cell.x, cell.y, cell.w, cell.h);
  ctx.clip();
  if (!drawMark(ctx, char, cell)) {
    ctx.fillStyle = "#fff";
    ctx.font = `${Math.round(13 * cell.dpr)}px ${cell.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(char, cell.x + cell.w / 2, cell.y + cell.h / 2 + 0.5 * cell.dpr);
  }
  ctx.restore();
}

/** Whether `char` is drawn from geometry (the marks) rather than set in a font. */
export const isDrawnMark = (char: string): boolean =>
  LINES.has(char) || char in QUADRANTS || "►◄▼▲●○◐◆✓✗▌░▒▓".includes(char);
