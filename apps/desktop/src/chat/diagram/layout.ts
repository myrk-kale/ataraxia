import type { Direction, Graph, GraphNode } from "./parse";

/** A box is always three rows: its top, its label, its bottom. */
export const NODE_H = 3;
/** Empty cells kept round the drawing, where an edge may run to get round a node. */
export const MARGIN = 2;
export const MAX_COLS = 260;
export const MAX_ROWS = 120;

const MIN_NODE_W = 8;
const RANK_GAP_ROWS = 4;
const ROW_GAP = 3;
const NODE_GAP_COLS = 4;
const MIN_RANK_GAP_COLS = 8;
const MAX_RANK_GAP_COLS = 30;
const MAX_RANKS = 14;

export interface PlacedNode extends GraphNode {
  rank: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Cell = readonly [number, number];

export interface RoutedEdge {
  from: string;
  to: string;
  label: string | null;
  arrow: boolean;
  /** The cells the line runs through, from the one beside the source to the one beside the target. */
  path: Cell[];
  /** Where the label is written, when there is one and it fits. */
  labelAt: { x: number; y: number; text: string } | null;
}

export interface Layout {
  direction: Direction;
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: RoutedEdge[];
}

export type LayoutResult = { ok: true; layout: Layout } | { ok: false; reason: string };

/** A stable sort by a key per item; an item with no key keeps the place it had. */
function sortedBy<T>(items: T[], key: (item: T) => number | null): T[] {
  const keyed = items.map((item, at) => ({ item, at, key: key(item) }));
  keyed.forEach((entry, at) => {
    if (entry.key === null) {
      entry.key = at;
    }
  });
  return keyed.sort((a, b) => a.key! - b.key! || a.at - b.at).map((entry) => entry.item);
}

/** Splits the links into the ones that go forward and the ones that close a cycle. */
function findBackEdges(graph: Graph): Set<number> {
  const out = new Map<string, number[]>(graph.nodes.map((n) => [n.id, []]));
  graph.edges.forEach((edge, at) => out.get(edge.from)!.push(at));
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<number>();
  for (const root of graph.nodes) {
    if (state.get(root.id)) {
      continue;
    }
    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    state.set(root.id, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const links = out.get(top.id)!;
      if (top.next >= links.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const at = links[top.next]!;
      top.next += 1;
      const target = graph.edges[at]!.to;
      const seen = state.get(target) ?? 0;
      if (seen === 1) {
        back.add(at);
      } else if (seen === 0) {
        state.set(target, 1);
        stack.push({ id: target, next: 0 });
      }
    }
  }
  return back;
}

/** Each node's rank: how many links the longest chain leading to it has. */
function rankNodes(graph: Graph, back: Set<number>): Map<string, number> {
  const rank = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
  const forward = graph.edges.filter((_, at) => !back.has(at));
  // The graph without its back edges has no cycle, so this settles in at most one pass per node.
  for (let pass = 0; pass < graph.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of forward) {
      const next = Math.min(MAX_RANKS - 1, rank.get(edge.from)! + 1);
      if (next > rank.get(edge.to)!) {
        rank.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return rank;
}

/** Puts each rank's nodes in an order that keeps links short and crossings few. */
function orderRanks(graph: Graph, rank: Map<string, number>, back: Set<number>): string[][] {
  const count = Math.max(...rank.values()) + 1;
  const groups: string[][] = Array.from({ length: count }, () => []);
  for (const node of graph.nodes) {
    groups[rank.get(node.id)!]!.push(node.id);
  }
  const forward = graph.edges.filter((_, at) => !back.has(at));
  const position = new Map<string, number>();
  const note = () => groups.forEach((group) => group.forEach((id, at) => position.set(id, at)));
  note();
  const barycenter = (neighbours: (edge: (typeof forward)[number]) => string | null) => {
    const places = forward.map(neighbours).filter((n): n is string => n !== null).map((n) => position.get(n)!);
    return places.length === 0 ? null : places.reduce((a, b) => a + b, 0) / places.length;
  };
  for (let sweep = 0; sweep < 4; sweep += 1) {
    for (let r = 1; r < count; r += 1) {
      groups[r] = sortedBy(groups[r]!, (id) =>
        barycenter((e) => (e.to === id && rank.get(e.from) === r - 1 ? e.from : null)),
      );
      note();
    }
    for (let r = count - 2; r >= 0; r -= 1) {
      groups[r] = sortedBy(groups[r]!, (id) =>
        barycenter((e) => (e.from === id && rank.get(e.to) === r + 1 ? e.to : null)),
      );
      note();
    }
  }
  return groups;
}

/** A min-heap of states by cost, for the path search. */
class Heap {
  private costs: number[] = [];
  private states: number[] = [];

  get size() {
    return this.costs.length;
  }

  push(cost: number, state: number) {
    let at = this.costs.length;
    this.costs.push(cost);
    this.states.push(state);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.costs[parent]! <= cost) {
        break;
      }
      this.swap(at, parent);
      at = parent;
    }
  }

  pop(): number {
    const top = this.states[0]!;
    const lastCost = this.costs.pop()!;
    const lastState = this.states.pop()!;
    if (this.costs.length > 0) {
      this.costs[0] = lastCost;
      this.states[0] = lastState;
      let at = 0;
      for (;;) {
        const left = 2 * at + 1;
        const right = left + 1;
        let least = at;
        if (left < this.costs.length && this.costs[left]! < this.costs[least]!) {
          least = left;
        }
        if (right < this.costs.length && this.costs[right]! < this.costs[least]!) {
          least = right;
        }
        if (least === at) {
          break;
        }
        this.swap(at, least);
        at = least;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    [this.costs[a], this.costs[b]] = [this.costs[b]!, this.costs[a]!];
    [this.states[a], this.states[b]] = [this.states[b]!, this.states[a]!];
  }
}

const STEP: readonly Cell[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
const TURN_COST = 3;
/** Running along a line another link already uses is misleading (it looks like they join), so it costs a lot... */
const OVERLAP_COST = 14;
/** ...unless the two links share an end, where they really do run together, which is cheap. */
const SHARED_COST = 0.2;
const CROSS_COST = 2;
const HUG_COST = 1;
const MAX_EXPANSIONS = 200_000;

/** The two nodes a link joins, by position in the node list. */
interface Link {
  from: number;
  to: number;
}

/** Finds orthogonal routes between nodes on the grid that go round every box. */
class Router {
  private readonly blocked: Uint8Array;
  /** For each cell and each axis, the source and target node of the first link that runs there. */
  private readonly horizontalFrom: Int16Array;
  private readonly horizontalTo: Int16Array;
  private readonly verticalFrom: Int16Array;
  private readonly verticalTo: Int16Array;
  private readonly hugging: Uint8Array;
  private readonly dist: Float32Array;
  private readonly from: Int32Array;

  constructor(
    private readonly width: number,
    private readonly height: number,
    nodes: PlacedNode[],
  ) {
    const cells = width * height;
    this.blocked = new Uint8Array(cells);
    this.horizontalFrom = new Int16Array(cells).fill(-1);
    this.horizontalTo = new Int16Array(cells).fill(-1);
    this.verticalFrom = new Int16Array(cells).fill(-1);
    this.verticalTo = new Int16Array(cells).fill(-1);
    this.hugging = new Uint8Array(cells);
    this.dist = new Float32Array(cells * 4);
    this.from = new Int32Array(cells * 4);
    for (const node of nodes) {
      for (let y = node.y; y < node.y + node.h; y += 1) {
        for (let x = node.x; x < node.x + node.w; x += 1) {
          this.blocked[y * width + x] = 1;
        }
      }
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (this.blocked[y * width + x]) {
          continue;
        }
        const touches = STEP.some(([dx, dy]) => {
          const nx = x + dx;
          const ny = y + dy;
          return nx >= 0 && ny >= 0 && nx < width && ny < height && this.blocked[ny * width + nx] === 1;
        });
        this.hugging[y * width + x] = touches ? 1 : 0;
      }
    }
  }

  /** The route from `start` (going `out`) to `end` (arriving going `into`), or null. */
  route(start: Cell, out: number, end: Cell, into: number, link: Link): Cell[] | null {
    const { width, height } = this;
    this.dist.fill(Infinity);
    this.from.fill(-1);
    const heap = new Heap();
    const begin = (start[1] * width + start[0]) * 4 + out;
    this.dist[begin] = 0;
    heap.push(0, begin);
    const goal = (end[1] * width + end[0]) * 4 + into;
    let expansions = 0;
    while (heap.size > 0 && expansions < MAX_EXPANSIONS) {
      const state = heap.pop();
      expansions += 1;
      if (state === goal) {
        const path: Cell[] = [];
        for (let at = state; at !== -1; at = this.from[at]!) {
          const cell = at >> 2;
          path.push([cell % width, Math.floor(cell / width)]);
        }
        return path.reverse();
      }
      const cell = state >> 2;
      const dir = state & 3;
      const x = cell % width;
      const y = Math.floor(cell / width);
      const base = this.dist[state]!;
      for (let next = 0; next < 4; next += 1) {
        if (next === ((dir + 2) & 3)) {
          continue;
        }
        const nx = x + STEP[next]![0];
        const ny = y + STEP[next]![1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || this.blocked[ny * width + nx]) {
          continue;
        }
        const at = ny * width + nx;
        const cost =
          base + 1 + (next === dir ? 0 : TURN_COST) + this.crowding(at, next & 1, link) + this.hugging[at]! * HUG_COST;
        const key = at * 4 + next;
        if (cost < this.dist[key]!) {
          this.dist[key] = cost;
          this.from[key] = state;
          const distance = Math.abs(nx - end[0]) + Math.abs(ny - end[1]);
          heap.push(cost + distance, key);
        }
      }
    }
    return null;
  }

  /** What it costs to run through a cell along an axis (1 horizontal, 0 vertical) given the links already there. */
  private crowding(at: number, horizontal: number, link: Link): number {
    const [along, across] = horizontal
      ? [this.horizontalFrom, this.verticalFrom]
      : [this.verticalFrom, this.horizontalFrom];
    const alongTo = horizontal ? this.horizontalTo : this.verticalTo;
    let cost = 0;
    if (along[at] !== -1) {
      cost += along[at] === link.from || alongTo[at] === link.to ? SHARED_COST : OVERLAP_COST;
    }
    if (across[at] !== -1) {
      cost += CROSS_COST;
    }
    return cost;
  }

  /** Remembers a route, so later ones keep off it where they can. */
  claim(path: Cell[], link: Link) {
    for (let i = 1; i < path.length; i += 1) {
      const [px, py] = path[i - 1]!;
      const [qx, qy] = path[i]!;
      const [from, to] = py === qy ? [this.horizontalFrom, this.horizontalTo] : [this.verticalFrom, this.verticalTo];
      for (const at of [py * this.width + px, qy * this.width + qx]) {
        if (from[at] === -1) {
          from[at] = link.from;
          to[at] = link.to;
        }
      }
    }
  }
}

/** The way a line leaves a node's side and arrives at another's, for each direction of flow. */
function ports(direction: Direction, from: PlacedNode, to: PlacedNode) {
  const cx = (n: PlacedNode) => n.x + Math.floor(n.w / 2);
  const cy = (n: PlacedNode) => n.y + Math.floor(n.h / 2);
  switch (direction) {
    case "LR":
      return { start: [from.x + from.w, cy(from)] as Cell, out: 1, end: [to.x - 1, cy(to)] as Cell, into: 1 };
    case "RL":
      return { start: [from.x - 1, cy(from)] as Cell, out: 3, end: [to.x + to.w, cy(to)] as Cell, into: 3 };
    case "TD":
      return { start: [cx(from), from.y + from.h] as Cell, out: 2, end: [cx(to), to.y - 1] as Cell, into: 2 };
    case "BT":
      return { start: [cx(from), from.y - 1] as Cell, out: 0, end: [cx(to), to.y + to.h] as Cell, into: 0 };
  }
}

/** A route that ignores the boxes, for the rare case the search finds none. */
function straightRoute(start: Cell, end: Cell, horizontal: boolean): Cell[] {
  const path: Cell[] = [start];
  let [x, y] = start;
  const walk = (tx: number, ty: number) => {
    while (x !== tx || y !== ty) {
      if (x !== tx) {
        x += Math.sign(tx - x);
      } else {
        y += Math.sign(ty - y);
      }
      path.push([x, y]);
    }
  };
  if (horizontal) {
    walk(Math.round((start[0] + end[0]) / 2), start[1]);
    walk(x, end[1]);
    walk(end[0], end[1]);
  } else {
    walk(start[0], Math.round((start[1] + end[1]) / 2));
    walk(end[0], y);
    walk(end[0], end[1]);
  }
  return path;
}

interface Run {
  /** The fixed coordinate, and where the run starts and ends along the other. */
  fixed: number;
  from: number;
  to: number;
}

/** The straight stretches of a path, horizontal and vertical, between its turns. */
function runsOf(path: Cell[]): { horizontal: Run[]; vertical: Run[] } {
  const horizontal: Run[] = [];
  const vertical: Run[] = [];
  const turns = [0];
  for (let at = 1; at < path.length - 1; at += 1) {
    const before = path[at - 1]!;
    const here = path[at]!;
    const after = path[at + 1]!;
    if (here[0] - before[0] !== after[0] - here[0] || here[1] - before[1] !== after[1] - here[1]) {
      turns.push(at);
    }
  }
  turns.push(path.length - 1);
  for (let i = 1; i < turns.length; i += 1) {
    const from = path[turns[i - 1]!]!;
    const to = path[turns[i]!]!;
    if (from[1] === to[1]) {
      horizontal.push({ fixed: from[1], from: Math.min(from[0], to[0]), to: Math.max(from[0], to[0]) });
    } else if (from[0] === to[0]) {
      vertical.push({ fixed: from[0], from: Math.min(from[1], to[1]), to: Math.max(from[1], to[1]) });
    }
  }
  return { horizontal, vertical };
}

/** Writes a label on its link: in the line itself if a stretch is long enough, else beside it. */
function placeLabels(edges: RoutedEdge[], nodes: PlacedNode[], width: number, height: number) {
  const text = new Uint8Array(width * height);
  const nodeCells = new Uint8Array(width * height);
  for (const node of nodes) {
    for (let y = node.y; y < node.y + node.h; y += 1) {
      for (let x = node.x; x < node.x + node.w; x += 1) {
        nodeCells[y * width + x] = 1;
      }
    }
  }
  const free = (x: number, y: number, length: number) => {
    if (x < 0 || y < 0 || y >= height || x + length > width) {
      return false;
    }
    for (let i = 0; i < length; i += 1) {
      if (nodeCells[y * width + x + i] || text[y * width + x + i]) {
        return false;
      }
    }
    return true;
  };
  const claim = (x: number, y: number, length: number) => {
    for (let i = 0; i < length; i += 1) {
      text[y * width + x + i] = 1;
    }
  };
  for (const edge of edges) {
    if (!edge.label) {
      continue;
    }
    const label = edge.label;
    const { horizontal, vertical } = runsOf(edge.path);
    // The cells at both ends of a path (beside a node, and the arrowhead) stay line.
    const inner = horizontal
      .map((run) => ({ ...run, from: run.from + 1, to: run.to - 1 }))
      .filter((run) => run.to >= run.from)
      .sort((a, b) => b.to - b.from - (a.to - a.from));
    const inline = ` ${label} `;
    let chosen: { x: number; y: number; text: string } | null = null;
    const run = inner[0];
    if (run && run.to - run.from + 1 >= inline.length + 2) {
      const x = run.from + Math.floor((run.to - run.from + 1 - inline.length) / 2);
      if (free(x, run.fixed, inline.length)) {
        chosen = { x, y: run.fixed, text: inline };
      }
    }
    if (!chosen) {
      const longest = [...vertical].sort((a, b) => b.to - b.from - (a.to - a.from))[0];
      if (longest) {
        const y = Math.floor((longest.from + longest.to) / 2);
        for (const x of [longest.fixed + 2, longest.fixed - label.length - 1]) {
          if (free(x, y, label.length)) {
            chosen = { x, y, text: label };
            break;
          }
        }
      }
    }
    if (!chosen && run) {
      for (const y of [run.fixed - 1, run.fixed + 1]) {
        const x = run.from;
        if (free(x, y, label.length)) {
          chosen = { x, y, text: label };
          break;
        }
      }
    }
    if (chosen) {
      claim(chosen.x, chosen.y, chosen.text.length);
      edge.labelAt = chosen;
    }
  }
}

export function layoutGraph(graph: Graph): LayoutResult {
  const back = findBackEdges(graph);
  const rank = rankNodes(graph, back);
  const groups = orderRanks(graph, rank, back);
  const horizontal = graph.direction === "LR" || graph.direction === "RL";
  const reversed = graph.direction === "RL" || graph.direction === "BT";
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const placed = new Map<string, PlacedNode>();
  for (const node of graph.nodes) {
    placed.set(node.id, {
      ...node,
      rank: rank.get(node.id)!,
      x: 0,
      y: 0,
      w: Math.max(MIN_NODE_W, [...node.label].length + 4),
      h: NODE_H,
    });
  }
  const ranks = groups.length;
  const rankSize = groups.map((group) => Math.max(...group.map((id) => (horizontal ? placed.get(id)!.w : NODE_H))));
  let width: number;
  let height: number;

  if (horizontal) {
    const gaps = Array.from({ length: Math.max(0, ranks - 1) }, (_, r) => {
      const widest = Math.max(
        0,
        ...graph.edges
          .filter((e) => rank.get(e.from)! === r && rank.get(e.to)! > r && e.label)
          .map((e) => [...e.label!].length + 6),
      );
      return Math.min(MAX_RANK_GAP_COLS, Math.max(MIN_RANK_GAP_COLS, widest));
    });
    const left: number[] = [];
    let at = MARGIN;
    rankSize.forEach((size, r) => {
      left.push(at);
      at += size + (gaps[r] ?? 0);
    });
    width = at + MARGIN;
    const pitch = NODE_H + ROW_GAP;
    const most = Math.max(...groups.map((g) => g.length));
    height = MARGIN * 2 + (most - 1) * pitch + NODE_H;
    groups.forEach((group, r) => {
      const offset = Math.floor(((most - group.length) * pitch) / 2);
      group.forEach((id, i) => {
        const node = placed.get(id)!;
        node.x = left[r]! + Math.floor((rankSize[r]! - node.w) / 2);
        node.y = MARGIN + offset + i * pitch;
      });
    });
  } else {
    const pitch = NODE_H + RANK_GAP_ROWS;
    const widths = groups.map((group) => group.reduce((sum, id) => sum + placed.get(id)!.w, 0) + (group.length - 1) * NODE_GAP_COLS);
    const widest = Math.max(...widths);
    width = MARGIN * 2 + widest;
    height = MARGIN * 2 + (ranks - 1) * pitch + NODE_H;
    groups.forEach((group, r) => {
      let x = MARGIN + Math.floor((widest - widths[r]!) / 2);
      for (const id of group) {
        const node = placed.get(id)!;
        node.x = x;
        node.y = MARGIN + r * pitch;
        x += node.w + NODE_GAP_COLS;
      }
    });
  }
  if (width > MAX_COLS || height > MAX_ROWS) {
    return { ok: false, reason: "the diagram is too big to draw as text" };
  }
  if (reversed) {
    for (const node of placed.values()) {
      if (horizontal) {
        node.x = width - node.x - node.w;
      } else {
        node.y = height - node.y - node.h;
      }
    }
  }

  const nodes = graph.nodes.map((n) => placed.get(n.id)!);
  const router = new Router(width, height, nodes);
  const edges: RoutedEdge[] = [];
  for (const edge of graph.edges) {
    const from = placed.get(edge.from)!;
    const to = placed.get(edge.to)!;
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      continue;
    }
    const port = ports(graph.direction, from, to);
    const link = { from: nodes.indexOf(from), to: nodes.indexOf(to) };
    const path =
      router.route(port.start, port.out, port.end, port.into, link) ?? straightRoute(port.start, port.end, horizontal);
    router.claim(path, link);
    edges.push({ from: edge.from, to: edge.to, label: edge.label, arrow: edge.arrow, path, labelAt: null });
  }
  placeLabels(edges, nodes, width, height);
  return { ok: true, layout: { direction: graph.direction, width, height, nodes, edges } };
}
