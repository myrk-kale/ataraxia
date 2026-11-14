import {
  ARROWS,
  ARROWS_ASCII,
  DOWN,
  LEFT,
  RIGHT,
  STYLES,
  UP,
  allNarrow,
  lineGlyph,
  type StyleName,
} from "./glyphs";
import { layoutGraph, type Layout, type PlacedNode, type RoutedEdge } from "./layout";
import { K } from "./palette";
import { parseFlowchart, type Direction, type Graph } from "./parse";
import { charOf, glyph } from "./registry";

/** A node's cells, as indices into the scene's flat arrays (`y * width + x`). */
export interface SceneNode {
  id: string;
  label: string;
  rank: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The box, clockwise from its top-left corner. */
  border: number[];
  /** Where the label is written, in order. */
  labelCells: number[];
  /** Every cell that is drawn: the box and the label. */
  all: number[];
}

export interface SceneEdge {
  from: string;
  to: string;
  /** The line, from the node it leaves to the node it reaches, arrowhead last. */
  cells: number[];
  hasArrow: boolean;
  labelCells: number[];
}

/** A diagram as a grid of characters, ready to be drawn and animated. */
export interface Scene {
  width: number;
  height: number;
  style: StyleName;
  direction: Direction;
  nodes: SceneNode[];
  edges: SceneEdge[];
  /** The nodes in the order a reader would follow the flow. */
  order: SceneNode[];
  /** What each cell shows when the diagram is at rest, and in which colour class. */
  baseGlyph: Uint16Array;
  baseCls: Uint8Array;
  /** The finished drawing as plain text, for copying. */
  text: string;
  /** What the drawing says, in words, for a screen reader. */
  alt: string;
}

export type SceneResult = { ok: true; scene: Scene } | { ok: false; reason: string };

const WAYS: Record<Direction, string> = {
  LR: "left to right",
  RL: "right to left",
  TD: "top to bottom",
  BT: "bottom to top",
};

function describe(graph: Graph): string {
  const label = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const linked = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
  const links = graph.edges.map(
    (e) => `${label.get(e.from)} ${e.arrow ? "to" : "linked with"} ${label.get(e.to)}${e.label ? ` (${e.label})` : ""}`,
  );
  const alone = graph.nodes.filter((n) => !linked.has(n.id)).map((n) => n.label);
  const parts = [`Flowchart, ${WAYS[graph.direction]}.`];
  if (links.length > 0) {
    parts.push(`${links.join("; ")}.`);
  }
  if (alone.length > 0) {
    parts.push(`Not linked: ${alone.join(", ")}.`);
  }
  return parts.join(" ");
}

function arrowFor(style: StyleName, dx: number, dy: number): string {
  const set = style === "ascii" ? ARROWS_ASCII : ARROWS;
  if (dx > 0) {
    return set.right;
  }
  if (dx < 0) {
    return set.left;
  }
  return dy > 0 ? set.down : set.up;
}

export function rasterize(layout: Layout, graph: Graph, style: StyleName): Scene {
  const { width, height } = layout;
  const look = STYLES[style];
  const cells = width * height;
  const at = (x: number, y: number) => y * width + x;
  const baseGlyph = new Uint16Array(cells);
  const baseCls = new Uint8Array(cells);
  const put = (x: number, y: number, char: string, cls: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return;
    }
    baseGlyph[at(x, y)] = glyph(char);
    baseCls[at(x, y)] = cls;
  };

  // The lines first, as the directions each cell is joined in, so a meeting of lines gets
  // the right corner or tee.
  const joined = new Uint8Array(cells);
  for (const edge of layout.edges) {
    for (let i = 1; i < edge.path.length; i += 1) {
      const [px, py] = edge.path[i - 1]!;
      const [qx, qy] = edge.path[i]!;
      const [a, b] = qx > px ? [RIGHT, LEFT] : qx < px ? [LEFT, RIGHT] : qy > py ? [DOWN, UP] : [UP, DOWN];
      joined[at(px, py)]! |= a;
      joined[at(qx, qy)]! |= b;
    }
  }
  for (let i = 0; i < cells; i += 1) {
    if (joined[i]) {
      put(i % width, Math.floor(i / width), lineGlyph(look, joined[i]!), K.edge);
    }
  }
  const edges: SceneEdge[] = layout.edges.map((edge: RoutedEdge) => {
    const path = edge.path.map(([x, y]) => at(x, y));
    if (edge.arrow && edge.path.length >= 2) {
      const [lx, ly] = edge.path.at(-1)!;
      const [bx, by] = edge.path.at(-2)!;
      put(lx, ly, arrowFor(style, lx - bx, ly - by), K.arrow);
    }
    const labelCells: number[] = [];
    if (edge.labelAt) {
      [...edge.labelAt.text].forEach((char, i) => {
        if (char !== " ") {
          put(edge.labelAt!.x + i, edge.labelAt!.y, char, K.box);
        } else {
          // The space round an inline label clears the line under it.
          put(edge.labelAt!.x + i, edge.labelAt!.y, " ", K.none);
        }
        labelCells.push(at(edge.labelAt!.x + i, edge.labelAt!.y));
      });
    }
    return { from: edge.from, to: edge.to, cells: path, hasArrow: edge.arrow, labelCells };
  });

  const nodes: SceneNode[] = layout.nodes.map((node: PlacedNode) => {
    const { x, y, w, h } = node;
    const round = node.shape === "round";
    const [tl, tr, bl, br] = round
      ? [look.rtl, look.rtr, look.rbl, look.rbr]
      : [look.tl, look.tr, look.bl, look.br];
    const border: number[] = [];
    const sides = node.shape === "decision" ? ["<", ">"] : [look.v, look.v];
    for (let col = x; col < x + w; col += 1) {
      put(col, y, col === x ? tl : col === x + w - 1 ? tr : look.h, K.box);
      put(col, y + h - 1, col === x ? bl : col === x + w - 1 ? br : look.h, K.box);
    }
    for (let row = y + 1; row < y + h - 1; row += 1) {
      for (let col = x + 1; col < x + w - 1; col += 1) {
        baseGlyph[at(col, row)] = 0;
        baseCls[at(col, row)] = K.none;
      }
      put(x, row, sides[0]!, K.box);
      put(x + w - 1, row, sides[1]!, K.box);
    }
    for (let col = x; col < x + w; col += 1) {
      border.push(at(col, y));
    }
    for (let row = y + 1; row < y + h; row += 1) {
      border.push(at(x + w - 1, row));
    }
    for (let col = x + w - 2; col >= x; col -= 1) {
      border.push(at(col, y + h - 1));
    }
    for (let row = y + h - 2; row > y; row -= 1) {
      border.push(at(x, row));
    }
    const letters = [...node.label];
    const start = x + Math.max(2, Math.floor((w - letters.length) / 2));
    const labelCells = letters.map((char, i) => {
      put(start + i, y + 1, char, K.text);
      return at(start + i, y + 1);
    });
    const all = [...border, ...labelCells];
    return { id: node.id, label: node.label, rank: node.rank, x, y, w, h, border, labelCells, all };
  });

  const rows: string[] = [];
  for (let row = 0; row < height; row += 1) {
    let line = "";
    for (let col = 0; col < width; col += 1) {
      line += charOf(baseGlyph[at(col, row)]!);
    }
    rows.push(line.replace(/\s+$/, ""));
  }
  const order = [...nodes].sort((a, b) => a.rank - b.rank || a.y - b.y || a.x - b.x);
  return {
    width,
    height,
    style,
    direction: layout.direction,
    nodes,
    edges,
    order,
    baseGlyph,
    baseCls,
    text: rows.join("\n").replace(/^\n+|\n+$/g, ""),
    alt: describe(graph),
  };
}

export function buildScene(source: string, style: StyleName): SceneResult {
  const parsed = parseFlowchart(source);
  if (!parsed.ok) {
    return parsed;
  }
  const { graph } = parsed;
  if (!graph.nodes.every((n) => allNarrow(n.label)) || !graph.edges.every((e) => !e.label || allNarrow(e.label))) {
    return { ok: false, reason: "a label has characters wider than a cell" };
  }
  const laid = layoutGraph(graph);
  if (!laid.ok) {
    return laid;
  }
  return { ok: true, scene: rasterize(laid.layout, graph, style) };
}

const CACHE_LIMIT = 24;
const cache = new Map<string, SceneResult>();

/** `buildScene`, remembered: a diagram that scrolls away and back is not laid out again. */
export function cachedScene(source: string, style: StyleName): SceneResult {
  const key = `${style}\0${source}`;
  const known = cache.get(key);
  if (known) {
    cache.delete(key);
    cache.set(key, known);
    return known;
  }
  const built = buildScene(source, style);
  cache.set(key, built);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  return built;
}
