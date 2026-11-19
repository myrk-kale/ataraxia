export type Point = { x: number; y: number };

/** Where a node starts: on a spiral, in a fixed order, so the same graph always settles the same way. */
function spiral(index: number, count: number): Point {
  const angle = index * 2.399963; // the golden angle
  const radius = 90 * Math.sqrt(index + 0.5) + count * 0.5;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/**
 * A force-directed layout: every node pushes the others away, every link pulls its two ends
 * together, and a weak pull toward the middle keeps separate clusters from drifting off. It is
 * deterministic (no randomness) so the graph does not rearrange itself when it reloads.
 */
export function layoutForce(
  ids: readonly string[],
  links: readonly { source: string; target: string }[],
  /** The box each node occupies; nodes are pushed apart until their boxes (plus a margin) stop overlapping. */
  box: { width: number; height: number } = { width: 208, height: 84 },
): Map<string, Point> {
  const count = ids.length;
  const index = new Map(ids.map((id, at) => [id, at]));
  const position = ids.map((_, at) => spiral(at, count));
  if (count < 2) {
    return new Map(ids.map((id, at) => [id, position[at]!]));
  }
  const edges = links
    .map((link) => [index.get(link.source), index.get(link.target)] as const)
    .filter((edge): edge is readonly [number, number] => edge[0] !== undefined && edge[1] !== undefined && edge[0] !== edge[1]);
  const rest = 300;
  const iterations = count > 300 ? 120 : 320;
  for (let step = 0; step < iterations; step += 1) {
    // Cooling: big moves first, small ones to settle.
    const heat = 1 - step / iterations;
    const force = position.map(() => ({ x: 0, y: 0 }));
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        let dx = position[a]!.x - position[b]!.x;
        let dy = position[a]!.y - position[b]!.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          dx = 0.01 * (a + 1);
          dy = 0.01 * (b + 1);
          distance = Math.hypot(dx, dy);
        }
        const push = 90000 / (distance * distance);
        force[a]!.x += (dx / distance) * push;
        force[a]!.y += (dy / distance) * push;
        force[b]!.x -= (dx / distance) * push;
        force[b]!.y -= (dy / distance) * push;
      }
    }
    for (const [a, b] of edges) {
      const dx = position[b]!.x - position[a]!.x;
      const dy = position[b]!.y - position[a]!.y;
      const distance = Math.max(Math.hypot(dx, dy), 0.01);
      const pull = (distance - rest) * 0.04;
      force[a]!.x += (dx / distance) * pull;
      force[a]!.y += (dy / distance) * pull;
      force[b]!.x -= (dx / distance) * pull;
      force[b]!.y -= (dy / distance) * pull;
    }
    for (let at = 0; at < count; at += 1) {
      force[at]!.x -= position[at]!.x * 0.012;
      force[at]!.y -= position[at]!.y * 0.012;
      const length = Math.hypot(force[at]!.x, force[at]!.y);
      const limit = 40 * heat + 1;
      const scale = length > limit ? limit / length : 1;
      position[at]!.x += force[at]!.x * scale;
      position[at]!.y += force[at]!.y * scale;
    }
  }
  separate(position, box);
  return new Map(ids.map((id, at) => [id, position[at]!]));
}

/** Pushes overlapping boxes apart along the axis where they overlap least, until none do. */
function separate(position: Point[], box: { width: number; height: number }) {
  const margin = 36;
  const wide = box.width + margin;
  const tall = box.height + margin;
  for (let round = 0; round < 80; round += 1) {
    let moved = false;
    for (let a = 0; a < position.length; a += 1) {
      for (let b = a + 1; b < position.length; b += 1) {
        const dx = position[b]!.x - position[a]!.x;
        const dy = position[b]!.y - position[a]!.y;
        const overlapX = wide - Math.abs(dx);
        const overlapY = tall - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) {
          continue;
        }
        moved = true;
        if (overlapX < overlapY) {
          const shift = (overlapX / 2 + 0.5) * (dx >= 0 ? 1 : -1);
          position[a]!.x -= shift;
          position[b]!.x += shift;
        } else {
          const shift = (overlapY / 2 + 0.5) * (dy >= 0 ? 1 : -1);
          position[a]!.y -= shift;
          position[b]!.y += shift;
        }
      }
    }
    if (!moved) {
      return;
    }
  }
}
