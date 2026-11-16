import { expect, it } from "vitest";
import { layoutGraph, titleColumns } from "./layout";
import { parseFlowchart } from "./parse";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function chart(seed: number): string {
  const r = rng(seed);
  const pick = (n: number) => Math.floor(r() * n);
  const nodeCount = 3 + pick(12);
  const groupCount = pick(5);
  const parent: (number | null)[] = [];
  const depth: number[] = [];
  for (let g = 0; g < groupCount; g += 1) {
    const candidates = [null, ...parent.map((_, i) => i).filter((i) => depth[i]! < 2)];
    const p = candidates[pick(candidates.length)] as number | null;
    parent.push(p);
    depth.push(p === null ? 0 : depth[p]! + 1);
  }
  const home: (number | null)[] = Array.from({ length: nodeCount }, () => (groupCount > 0 && r() < 0.7 ? pick(groupCount) : null));
  const lines: string[] = [`flowchart ${["TD", "LR", "RL", "BT"][pick(4)]}`];
  const emit = (g: number | null) => {
    for (let i = 0; i < nodeCount; i += 1) {
      if (home[i] === g) lines.push(`N${i}["node ${i} ${"word ".repeat(pick(6))}"]`);
    }
    for (let k = 0; k < groupCount; k += 1) {
      if (parent[k] === g) {
        lines.push(`subgraph G${k}["Group ${k}"]`);
        if (r() < 0.4) lines.push(`direction ${["LR", "TD"][pick(2)]}`);
        emit(k);
        lines.push("end");
      }
    }
  };
  emit(null);
  const edges = 2 + pick(nodeCount * 2);
  for (let e = 0; e < edges; e += 1) {
    const a = pick(nodeCount);
    const b = r() < 0.08 ? a : pick(nodeCount);
    lines.push(r() < 0.3 ? `N${a} -->|lbl ${e}| N${b}` : `N${a} --> N${b}`);
  }
  return lines.join("\n");
}

/** Charts of nodes, nested subgraphs, directions, labels and stray links, from fixed seeds. */
it("draws random charts of subgraphs soundly, or says it cannot, and never throws", () => {
  const report: string[] = [];
  let drawn = 0, refused = 0, tooBig = 0, bad = 0;
  const t0 = Date.now();
  for (let seed = 1; seed <= 300; seed += 1) {
    const source = chart(seed);
    const parsed = parseFlowchart(source);
    if (!parsed.ok) { refused += 1; continue; }
    let result;
    try { result = layoutGraph(parsed.graph); } catch (error) { bad += 1; report.push(`seed ${seed} THREW ${String(error)}\n${source}`); continue; }
    if (!result.ok) { tooBig += 1; continue; }
    drawn += 1;
    const l = result.layout;
    const problems: string[] = [];
    const inside = (f: {x:number;y:number;w:number;h:number}, n: {x:number;y:number;w:number;h:number}) => n.x >= f.x && n.x + n.w <= f.x + f.w && n.y >= f.y && n.y + n.h <= f.y + f.h;
    for (const n of parsed.graph.nodes) {
      const node = l.nodes.find((p) => p.id === n.id)!;
      const chainIds: string[] = [];
      for (let id = n.group; id !== null; id = parsed.graph.groups.find((g) => g.id === id)!.parent) chainIds.push(id);
      for (const f of l.frames) {
        const should = chainIds.includes(f.id);
        if (inside(f, node) !== should) problems.push(`node ${n.id} ${should ? "not in" : "inside"} frame ${f.id}`);
      }
    }
    l.nodes.forEach((a, i) => l.nodes.slice(i + 1).forEach((b) => {
      if (!(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)) problems.push(`nodes ${a.id}/${b.id} overlap`);
    }));
    for (const e of l.edges) {
      for (const [x, y] of e.path) {
        for (const n of l.nodes) if (x >= n.x && x < n.x + n.w && y >= n.y && y < n.y + n.h) problems.push(`edge ${e.from}->${e.to} through ${n.id}`);
        for (const f of l.frames) if (y === f.y && titleColumns(f).includes(x)) problems.push(`edge ${e.from}->${e.to} over title ${f.id}`);
      }
    }
    for (const a of l.frames) for (const b of l.frames) {
      if (a.id < b.id) {
        const nested = inside(a, b) || inside(b, a);
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        if (!nested && !apart) problems.push(`frames ${a.id}/${b.id} overlap`);
      }
    }
    if (problems.length) { bad += 1; report.push(`seed ${seed}: ${[...new Set(problems)].slice(0, 4).join("; ")}\n${source}`); }
  }
  expect(report.slice(0, 3).join("\n\n----\n")).toBe("");
  expect(bad).toBe(0);
  // Most of them are drawn, so the checks above are not passing for want of anything to check.
  expect(drawn).toBeGreaterThan(150);
  expect(Date.now() - t0).toBeLessThan(10_000);
  void refused;
  void tooBig;
});
