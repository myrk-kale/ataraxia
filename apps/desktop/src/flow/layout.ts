export type Placed = { x: number; y: number; layer: number };

/** `across` runs layers left to right; `down` runs them top to bottom. */
export type Direction = "across" | "down";

const COLUMN = 280;
const ROW = 104;
// Going down, nodes in a layer sit side by side, so the gaps are set by the node width and height.
const SPREAD = 250;
const STEP = 124;

/**
 * A long chain laid across needs more width than the window has, and fit-to-screen then shrinks
 * the nodes until their text cannot be read. When the layers would not fit, run them downwards.
 */
export function flowDirection(layerCount: number, width: number): Direction {
  return layerCount * COLUMN > Math.max(width, 640) ? "down" : "across";
}

/**
 * Layered left-to-right layout. Cycles are broken at their back edges, every node sits one
 * layer after its deepest predecessor, and nodes in a layer are ordered by where their
 * predecessors sit so edges cross as little as is cheap to get.
 */
export function layoutGraph(
  nodeIds: readonly string[],
  edges: readonly { source: string; target: string }[],
  direction: Direction = "across",
): Map<string, Placed> {
  const known = new Set(nodeIds);
  const forward = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  const state = new Map<string, 0 | 1 | 2>();
  const usable = edges.filter((edge) => known.has(edge.source) && known.has(edge.target) && edge.source !== edge.target);
  for (const edge of usable) {
    forward.get(edge.source)!.push(edge.target);
  }
  // Drop the edges that close a cycle.
  const back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const next of forward.get(id)!) {
      const status = state.get(next) ?? 0;
      if (status === 1) {
        back.add(`${id}->${next}`);
      } else if (status === 0) {
        visit(next);
      }
    }
    state.set(id, 2);
  };
  for (const id of nodeIds) {
    if (!state.has(id)) {
      visit(id);
    }
  }
  const acyclic = usable.filter((edge) => !back.has(`${edge.source}->${edge.target}`));

  const incoming = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of acyclic) {
    incoming.get(edge.target)!.push(edge.source);
  }
  const layer = new Map<string, number>();
  const depth = (id: string): number => {
    const cached = layer.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const value = incoming.get(id)!.reduce((max, from) => Math.max(max, depth(from) + 1), 0);
    layer.set(id, value);
    return value;
  };
  nodeIds.forEach(depth);

  const layers: string[][] = [];
  for (const id of nodeIds) {
    (layers[layer.get(id)!] ??= []).push(id);
  }
  const order = new Map<string, number>();
  layers.forEach((members) => members?.forEach((id, index) => order.set(id, index)));
  for (let sweep = 0; sweep < 2; sweep += 1) {
    for (const members of layers) {
      if (!members) {
        continue;
      }
      const score = (id: string) => {
        const from = incoming.get(id)!;
        return from.length === 0 ? order.get(id)! : from.reduce((sum, item) => sum + order.get(item)!, 0) / from.length;
      };
      members.sort((a, b) => score(a) - score(b));
      members.forEach((id, index) => order.set(id, index));
    }
  }

  const down = direction === "down";
  const tallest = Math.max(1, ...layers.map((members) => members?.length ?? 0));
  const placed = new Map<string, Placed>();
  layers.forEach((members, index) => {
    if (!members) {
      return;
    }
    const offset = ((tallest - members.length) * (down ? SPREAD : ROW)) / 2;
    members.forEach((id, row) =>
      placed.set(
        id,
        down
          ? { x: offset + row * SPREAD, y: index * STEP, layer: index }
          : { x: index * COLUMN, y: offset + row * ROW, layer: index },
      ),
    );
  });
  return placed;
}
