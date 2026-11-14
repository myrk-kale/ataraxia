import { K } from "./palette";
import { glyph } from "./registry";
import type { Scene, SceneEdge, SceneNode } from "./scene";

export type EffectId = "reveal" | "flow" | "steps" | "pulse" | "typing" | "states" | "glitch";

export const EFFECTS: readonly EffectId[] = ["reveal", "flow", "steps", "pulse", "typing", "states", "glitch"];

export const EFFECT_LABELS: Record<EffectId, string> = {
  reveal: "Draw in",
  flow: "Data flow",
  steps: "Step by step",
  pulse: "Node pulse",
  typing: "Typing",
  states: "State changes",
  glitch: "Matrix glitch",
};

export const EFFECT_HINTS: Record<EffectId, string> = {
  reveal: "Each box and link is drawn in the order of the flow.",
  flow: "Packets travel along the real routes of the links.",
  steps: "One stage is lit at a time; the ones before stay done.",
  pulse: "Each node lights up in turn, and the link after it follows.",
  typing: "The names are typed with a cursor, then linked.",
  states: "Every node goes from idle to running to done.",
  glitch: "The characters scramble, then settle into the diagram.",
};

/** A picture of the grid: which character is in each cell and in which colour class. */
export class Frame {
  readonly glyph: Uint16Array;
  readonly cls: Uint8Array;

  constructor(readonly size: number) {
    this.glyph = new Uint16Array(size);
    this.cls = new Uint8Array(size);
  }
}

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));

/** A number from 0 to 1 that is always the same for the same inputs. */
function hash(a: number, b: number): number {
  let n = Math.imul(a + 31, 73856093) ^ Math.imul(b + 17, 19349663);
  n ^= n >>> 13;
  n = Math.imul(n, 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/** The characters the effects draw with, numbered once. */
function marks(plain: boolean) {
  return plain
    ? { packet: glyph("o"), ripple: glyph("*"), cursor: glyph("_"), idle: glyph("o"), running: glyph("~"), done: glyph("+"), failed: glyph("x") }
    : { packet: glyph("●"), ripple: glyph("◆"), cursor: glyph("▌"), idle: glyph("○"), running: glyph("◐"), done: glyph("✓"), failed: glyph("✗") };
}

const NOISE = [...("#%@*+=/:;x?01░▒▓▖▘▚▞▛▜▙▟")];

function noise() {
  return NOISE.map((char) => glyph(char));
}

function rest(scene: Scene, frame: Frame) {
  frame.glyph.set(scene.baseGlyph);
  frame.cls.set(scene.baseCls);
}

function clear(frame: Frame) {
  frame.glyph.fill(0);
  frame.cls.fill(0);
}

/** Shows `cells` as they rest, in `cls`. */
function show(scene: Scene, frame: Frame, cells: readonly number[], cls: number | null, count = cells.length) {
  const upTo = Math.min(count, cells.length);
  for (let i = 0; i < upTo; i += 1) {
    const cell = cells[i]!;
    if (scene.baseGlyph[cell]) {
      frame.glyph[cell] = scene.baseGlyph[cell]!;
      frame.cls[cell] = cls ?? scene.baseCls[cell]!;
    }
  }
}

const showNode = (scene: Scene, frame: Frame, node: SceneNode, cls: number | null) => show(scene, frame, node.all, cls);

function showEdge(scene: Scene, frame: Frame, edge: SceneEdge, cls: number | null, progress = 1) {
  show(scene, frame, edge.cells, cls, Math.ceil(edge.cells.length * clamp(progress)));
  if (progress >= 1) {
    show(scene, frame, edge.labelCells, cls);
  }
}

const outgoing = (scene: Scene, node: SceneNode) => scene.edges.filter((e) => e.from === node.id);
const incoming = (scene: Scene, node: SceneNode) => scene.edges.filter((e) => e.to === node.id);

/** How long one cycle of an effect takes, in seconds. */
export function effectDuration(effect: EffectId, scene: Scene): number {
  const nodes = scene.nodes.length;
  const edges = scene.edges.length;
  switch (effect) {
    case "reveal":
      return clamp(0.9 + nodes * 0.32 + edges * 0.26, 1.4, 3.6);
    case "flow":
      return flowTiming(scene).total;
    case "steps":
      return nodes * STEP_S + 0.35;
    case "pulse":
      return nodes * PULSE_S + 0.4;
    case "typing":
      return nodes * TYPE_S + 0.6;
    case "states":
      return (nodes + 1) * STATE_S + 0.3;
    case "glitch":
      return 2.2;
  }
}

const STEP_S = 0.55;
const PULSE_S = 0.5;
const TYPE_S = 0.42;
const STATE_S = 0.5;
const PACKET_SPEED = 22;
const TRAIL = 3;

function flowTiming(scene: Scene) {
  const rank = new Map(scene.nodes.map((n) => [n.id, n.rank]));
  const starts = scene.edges.map((e) => (rank.get(e.from) ?? 0) * 0.45);
  const travels = scene.edges.map((e) => e.cells.length / PACKET_SPEED);
  const end = Math.max(0, ...starts.map((start, i) => start + travels[i]!));
  return { starts, travels, total: end + 0.5 };
}

/**
 * Draws one moment of an effect into `frame`. `t` is seconds into the cycle; `pass` counts
 * cycles, so an effect can vary from one to the next. Returns true once `t` is past the end,
 * when the frame holds the diagram at rest.
 */
export function renderEffect(effect: EffectId, scene: Scene, t: number, frame: Frame, pass = 0): boolean {
  if (t >= effectDuration(effect, scene) || t < 0) {
    rest(scene, frame);
    return t >= 0;
  }
  const plain = scene.style === "ascii";
  switch (effect) {
    case "reveal":
      reveal(scene, t, frame);
      break;
    case "flow":
      flow(scene, t, frame, plain);
      break;
    case "steps":
      steps(scene, t, frame);
      break;
    case "pulse":
      pulse(scene, t, frame, plain);
      break;
    case "typing":
      typing(scene, t, frame, plain);
      break;
    case "states":
      states(scene, t, frame, plain, pass);
      break;
    case "glitch":
      glitch(scene, t, frame);
      break;
  }
  return false;
}

/** The diagram at rest. */
export function renderRest(scene: Scene, frame: Frame) {
  rest(scene, frame);
}

function reveal(scene: Scene, t: number, frame: Frame) {
  clear(frame);
  const drawn = new Set<SceneEdge>();
  const steps: { node?: SceneNode; edge?: SceneEdge; units: number; start: number }[] = [];
  let units = 0;
  for (const node of scene.order) {
    steps.push({ node, units: 1, start: units });
    units += 1;
    for (const edge of outgoing(scene, node)) {
      if (!drawn.has(edge)) {
        drawn.add(edge);
        steps.push({ edge, units: 0.75, start: units });
        units += 0.75;
      }
    }
  }
  for (const edge of scene.edges) {
    if (!drawn.has(edge)) {
      steps.push({ edge, units: 0.75, start: units });
      units += 0.75;
    }
  }
  const unit = (effectDuration("reveal", scene) - 0.35) / units;
  for (const step of steps) {
    const local = clamp((t - step.start * unit) / (step.units * unit));
    if (local === 0) {
      continue;
    }
    if (step.node) {
      const node = step.node;
      show(scene, frame, node.border, local >= 1 ? null : K.bright, Math.floor(node.border.length * clamp(local * 1.3)));
      if (local > 0.6) {
        const letters = Math.floor(node.labelCells.length * clamp((local - 0.6) / 0.4));
        show(scene, frame, node.labelCells, local >= 1 ? null : K.active, letters);
      }
      if (local >= 1) {
        showNode(scene, frame, node, null);
      }
    } else if (step.edge) {
      showEdge(scene, frame, step.edge, local >= 1 ? null : K.bright, local);
    }
  }
}

function flow(scene: Scene, t: number, frame: Frame, plain: boolean) {
  rest(scene, frame);
  const { packet } = marks(plain);
  const { starts, travels } = flowTiming(scene);
  scene.edges.forEach((edge, i) => {
    const len = edge.cells.length;
    const local = t - starts[i]!;
    if (len === 0 || local < 0) {
      return;
    }
    const head = Math.floor(local * PACKET_SPEED);
    if (head < len) {
      for (let k = Math.max(0, head - TRAIL); k <= head; k += 1) {
        const cell = edge.cells[k]!;
        frame.cls[cell] = k === head ? K.packet : K.bright;
        if (k === head) {
          frame.glyph[cell] = packet;
        }
      }
    } else if (local - travels[i]! < 0.5) {
      const target = scene.nodes.find((n) => n.id === edge.to);
      if (target) {
        showNode(scene, frame, target, K.done);
      }
    }
  });
}

function steps(scene: Scene, t: number, frame: Frame) {
  rest(scene, frame);
  const index = Math.min(scene.order.length - 1, Math.floor(t / STEP_S));
  const local = (t - index * STEP_S) / STEP_S;
  const position = new Map(scene.order.map((n, i) => [n.id, i]));
  scene.order.forEach((node, i) => showNode(scene, frame, node, i < index ? K.done : i === index ? K.active : K.dim));
  for (const edge of scene.edges) {
    const from = position.get(edge.from)!;
    const to = position.get(edge.to)!;
    showEdge(scene, frame, edge, from < index && to <= index ? K.done : K.dim);
  }
  const current = scene.order[index];
  if (current) {
    for (const edge of incoming(scene, current)) {
      showEdge(scene, frame, edge, K.bright, local);
    }
  }
}

function pulse(scene: Scene, t: number, frame: Frame, plain: boolean) {
  rest(scene, frame);
  const { ripple } = marks(plain);
  const index = Math.min(scene.order.length - 1, Math.floor(t / PULSE_S));
  const phase = (t - index * PULSE_S) / PULSE_S;
  const current = scene.order[index];
  if (!current) {
    return;
  }
  showNode(scene, frame, current, phase < 0.3 ? K.active : K.bright);
  if (phase < 0.6) {
    for (let i = 0; i < current.border.length; i += 3) {
      const cell = current.border[i]!;
      if (hash(cell, index) > phase * 0.8 + 0.15) {
        frame.glyph[cell] = ripple;
        frame.cls[cell] = K.ripple;
      }
    }
  }
  for (const edge of outgoing(scene, current)) {
    showEdge(scene, frame, edge, phase < 0.5 ? K.bright : null, clamp(phase * 2));
  }
}

function typing(scene: Scene, t: number, frame: Frame, plain: boolean) {
  clear(frame);
  const { cursor } = marks(plain);
  const position = new Map(scene.order.map((n, i) => [n.id, i]));
  scene.order.forEach((node, i) => {
    const local = clamp((t - i * TYPE_S) / TYPE_S);
    show(scene, frame, node.border, local === 0 ? K.dim : local === 1 ? null : K.bright);
    if (local === 0) {
      return;
    }
    const letters = Math.min(node.labelCells.length, Math.floor(local * node.labelCells.length * 1.16));
    show(scene, frame, node.labelCells, local === 1 ? null : K.active, letters);
    if (local < 1 && letters < node.labelCells.length) {
      const at = node.labelCells[letters]!;
      frame.glyph[at] = cursor;
      frame.cls[at] = K.cursor;
    }
  });
  for (const edge of scene.edges) {
    const value = clamp((t - (position.get(edge.from)! + 0.65) * TYPE_S) / 0.5);
    if (value > 0) {
      showEdge(scene, frame, edge, value >= 1 ? null : K.bright, value);
    }
  }
}

function states(scene: Scene, t: number, frame: Frame, plain: boolean, pass: number) {
  rest(scene, frame);
  const symbol = marks(plain);
  const index = Math.floor(t / STATE_S);
  // Every other cycle of a looping animation one stage fails, to show that state too.
  const failing = pass % 2 === 1 ? Math.min(2, scene.order.length - 1) : -1;
  const failed = failing >= 0 && index >= failing;
  const position = new Map(scene.order.map((n, i) => [n.id, i]));
  scene.order.forEach((node, i) => {
    const broken = failed && i === failing;
    const status = broken ? "failed" : i < index && !(failed && i > failing) ? "done" : i === index && !failed ? "running" : "idle";
    const cls = status === "failed" ? K.warning : status === "done" ? K.done : status === "running" ? K.active : K.dim;
    showNode(scene, frame, node, cls);
    const at = (node.y + 1) * scene.width + node.x + 1;
    frame.glyph[at] = symbol[status === "idle" ? "idle" : status];
    frame.cls[at] = cls;
  });
  for (const edge of scene.edges) {
    const to = position.get(edge.to)!;
    if (failed && to >= failing) {
      showEdge(scene, frame, edge, K.dim);
    } else if (to < index) {
      showEdge(scene, frame, edge, K.done);
    } else if (to === index) {
      showEdge(scene, frame, edge, K.active);
    } else {
      showEdge(scene, frame, edge, K.dim);
    }
  }
}

function glitch(scene: Scene, t: number, frame: Frame) {
  rest(scene, frame);
  const symbols = noise();
  const scan = clamp(t / 1.6);
  const step = Math.floor(t * 14);
  const { width } = scene;
  for (let cell = 0; cell < frame.size; cell += 1) {
    if (!scene.baseGlyph[cell]) {
      continue;
    }
    const along = (cell % width) / width;
    const chance = hash(cell, step);
    if (along > scan || chance < 0.1 * (1 - scan) + 0.012) {
      frame.glyph[cell] = symbols[Math.floor(hash(cell + 13, step) * symbols.length)]!;
      frame.cls[cell] = K.glitch;
    } else if (Math.abs(along - scan) < 0.04) {
      frame.cls[cell] = K.bright;
    }
  }
}
