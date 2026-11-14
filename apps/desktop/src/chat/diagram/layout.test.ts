import { describe, expect, it } from "vitest";
import { MARGIN, MAX_COLS, NODE_H, layoutGraph, type Layout, type PlacedNode } from "./layout";
import { parseFlowchart } from "./parse";

function lay(source: string): Layout {
  const parsed = parseFlowchart(source);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  const result = layoutGraph(parsed.graph);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.layout;
}

const nodeAt = (layout: Layout, id: string): PlacedNode => layout.nodes.find((n) => n.id === id)!;
const inside = (node: PlacedNode, x: number, y: number) =>
  x >= node.x && x < node.x + node.w && y >= node.y && y < node.y + node.h;

/** Everything a drawing must satisfy whatever the graph. */
function expectSound(layout: Layout) {
  for (const node of layout.nodes) {
    expect(node.x).toBeGreaterThanOrEqual(0);
    expect(node.y).toBeGreaterThanOrEqual(0);
    expect(node.x + node.w).toBeLessThanOrEqual(layout.width);
    expect(node.y + node.h).toBeLessThanOrEqual(layout.height);
    expect(node.h).toBe(NODE_H);
  }
  layout.nodes.forEach((a, i) =>
    layout.nodes.slice(i + 1).forEach((b) => {
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart, `${a.id} and ${b.id} overlap`).toBe(true);
    }),
  );
  for (const edge of layout.edges) {
    expect(edge.path.length).toBeGreaterThan(1);
    edge.path.forEach(([x, y], at) => {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(layout.width);
      expect(y).toBeLessThan(layout.height);
      if (at > 0) {
        const [px, py] = edge.path[at - 1]!;
        expect(Math.abs(x - px) + Math.abs(y - py), `${edge.from}->${edge.to} jumps`).toBe(1);
      }
      for (const node of layout.nodes) {
        expect(inside(node, x, y), `${edge.from}->${edge.to} runs through ${node.id}`).toBe(false);
      }
    });
    const touches = (node: PlacedNode, [x, y]: readonly [number, number]) =>
      [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => inside(node, x + dx!, y + dy!));
    expect(touches(nodeAt(layout, edge.from), edge.path[0]!), `${edge.from} start`).toBe(true);
    expect(touches(nodeAt(layout, edge.to), edge.path.at(-1)!), `${edge.to} end`).toBe(true);
    if (edge.labelAt) {
      const { x, y, text } = edge.labelAt;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + text.length).toBeLessThanOrEqual(layout.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(layout.height);
      for (const node of layout.nodes) {
        for (let i = 0; i < text.length; i += 1) {
          expect(inside(node, x + i, y), `a label sits on ${node.id}`).toBe(false);
        }
      }
    }
  }
}

describe("layoutGraph", () => {
  it("lines up a chain left to right, each node past the last", () => {
    const layout = lay("flowchart LR\nA[Client] --> B[Gateway] --> C[Queue] --> D[Worker]");
    expectSound(layout);
    const xs = ["A", "B", "C", "D"].map((id) => nodeAt(layout, id).x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(new Set(["A", "B", "C", "D"].map((id) => nodeAt(layout, id).y)).size).toBe(1);
  });

  it("goes the other way for RL, and down for TD, and up for BT", () => {
    const xs = (d: string) => {
      const layout = lay(`flowchart ${d}\nA --> B --> C`);
      expectSound(layout);
      return ["A", "B", "C"].map((id) => nodeAt(layout, id));
    };
    const rl = xs("RL");
    expect(rl[0]!.x).toBeGreaterThan(rl[1]!.x);
    expect(rl[1]!.x).toBeGreaterThan(rl[2]!.x);
    const td = xs("TD");
    expect(td[0]!.y).toBeLessThan(td[1]!.y);
    expect(td[1]!.y).toBeLessThan(td[2]!.y);
    const bt = xs("BT");
    expect(bt[0]!.y).toBeGreaterThan(bt[1]!.y);
    expect(bt[1]!.y).toBeGreaterThan(bt[2]!.y);
  });

  it("sizes a box to its label, with a floor", () => {
    const layout = lay("flowchart LR\nA[Hi] --> B[A rather long label here]");
    expect(nodeAt(layout, "A").w).toBe(8);
    expect(nodeAt(layout, "B").w).toBe("A rather long label here".length + 4);
  });

  it("fans out into several rows and routes every link", () => {
    const layout = lay("flowchart LR\nR[Router] --> A[Service A]\nR --> B[Service B]\nR --> C[Service C]\nA --> D[(Storage)]\nB --> D\nC --> D");
    expectSound(layout);
    expect(layout.edges).toHaveLength(6);
    const ys = ["A", "B", "C"].map((id) => nodeAt(layout, id).y);
    expect(new Set(ys).size).toBe(3);
  });

  it("takes a link that skips a rank round the node in between", () => {
    const layout = lay("flowchart LR\nA --> B\nB --> C\nA --> C");
    expectSound(layout);
    const skip = layout.edges.find((e) => e.from === "A" && e.to === "C")!;
    const direct = skip.path.every(([, y]) => y === skip.path[0]![1]);
    expect(direct).toBe(false);
  });

  it("ranks a cycle by its forward links and still routes the link that closes it", () => {
    const layout = lay("flowchart LR\nA --> B --> C --> A");
    expectSound(layout);
    expect(["A", "B", "C"].map((id) => nodeAt(layout, id).rank)).toEqual([0, 1, 2]);
    expect(layout.edges).toHaveLength(3);
  });

  it("routes a link from a node to itself", () => {
    const layout = lay("flowchart LR\nA --> A");
    expectSound(layout);
    expect(layout.edges).toHaveLength(1);
  });

  it("makes room for a link label and writes it on the line", () => {
    const layout = lay("flowchart LR\nA -->|accepted| B");
    expectSound(layout);
    const label = layout.edges[0]!.labelAt!;
    expect(label.text).toBe(" accepted ");
    expect(layout.edges[0]!.path.some(([x, y]) => y === label.y && x === label.x + 3)).toBe(true);
    expect(nodeAt(layout, "B").x - (nodeAt(layout, "A").x + nodeAt(layout, "A").w)).toBeGreaterThanOrEqual("accepted".length + 4);
  });

  it("writes a label beside a vertical link in a top-down chart", () => {
    const layout = lay("flowchart TD\nA -->|ok| B");
    expectSound(layout);
    const label = layout.edges[0]!.labelAt!;
    expect(label.text).toBe("ok");
    expect(label.x).toBeGreaterThan(layout.edges[0]!.path[0]![0]);
  });

  it("keeps two labels from landing on each other", () => {
    const layout = lay("flowchart LR\nA -->|one| B\nA -->|two| B2\nB --> C\nB2 --> C");
    expectSound(layout);
    const [a, b] = layout.edges.map((e) => e.labelAt);
    if (a && b && a.y === b.y) {
      expect(a.x + a.text.length <= b.x || b.x + b.text.length <= a.x).toBe(true);
    }
  });

  it("is the same every time", () => {
    const source = "flowchart TD\nU --> A\nA --> O\nA --> P\nO --> N\nP --> N";
    expect(JSON.stringify(lay(source))).toBe(JSON.stringify(lay(source)));
  });

  it("keeps a margin round the drawing for links that go round", () => {
    const layout = lay("flowchart LR\nA --> B");
    expect(Math.min(...layout.nodes.map((n) => n.x))).toBeGreaterThanOrEqual(MARGIN);
    expect(Math.min(...layout.nodes.map((n) => n.y))).toBeGreaterThanOrEqual(MARGIN);
  });

  it("refuses a diagram that would need too many columns", () => {
    const names = Array.from({ length: 14 }, (_, i) => `N${i}[${"w".repeat(30)}]`);
    const parsed = parseFlowchart(`flowchart LR\n${names.join(" --> ")}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const result = layoutGraph(parsed.graph);
      expect(result.ok).toBe(false);
      expect(MAX_COLS).toBeGreaterThan(0);
    }
  });

  it("never makes two unrelated links run along the same line, which would look like they join", () => {
    const sources = [
      "flowchart LR\n  I[Incoming] --> V[Validate]\n  V --> R[Router]\n  R --> A[Service A]\n  R --> B[Service B]\n  A --> D[Storage]\n  B --> D\n  I --> D\n  D -.-> R",
      "flowchart LR\nA --> B\nB --> C\nA --> C",
      "flowchart TD\n  U[User] --> A[API]\n  A --> O[Orders]\n  A --> P[Payment]\n  O --> N[Notifier]\n  P --> N\n  U --> N",
      "flowchart LR\nA --> B --> C --> A\nB --> D --> C",
    ];
    for (const source of sources) {
      const layout = lay(source);
      for (const axis of ["horizontal", "vertical"] as const) {
        const users = new Map<string, Set<string>>();
        for (const edge of layout.edges) {
          for (let i = 1; i < edge.path.length; i += 1) {
            const [px, py] = edge.path[i - 1]!;
            const [qx, qy] = edge.path[i]!;
            if ((axis === "horizontal") !== (py === qy)) {
              continue;
            }
            for (const key of [`${px},${py}`, `${qx},${qy}`]) {
              (users.get(key) ?? users.set(key, new Set()).get(key)!).add(`${edge.from}>${edge.to}`);
            }
          }
        }
        for (const [cell, links] of users) {
          const list = [...links].map((l) => l.split(">") as [string, string]);
          list.forEach((a, i) =>
            list.slice(i + 1).forEach((b) => {
              expect(a[0] === b[0] || a[1] === b[1], `${a.join("->")} and ${b.join("->")} run together ${axis}ly at ${cell}`).toBe(true);
            }),
          );
        }
      }
    }
  });

  it("lays out the examples of a typical agent answer without a problem", () => {
    for (const source of [
      "flowchart LR\n  C[Client] --> G[API Gateway]\n  G --> Q[Queue]\n  Q --> W[Worker]\n  W --> D[(Database)]",
      "flowchart TD\n  U[User] --> A[API]\n  A --> O[Orders]\n  A --> P[Payment]\n  O --> N[Notifier]\n  P --> N",
      "flowchart LR\n  I[Incoming] --> V[Validate]\n  V --> R[Router]\n  R --> A[Service A]\n  R --> B[Service B]\n  A --> D[Storage]\n  B --> D",
      "flowchart TD\n  S([Start]) --> Q{Valid?}\n  Q -->|yes| P[Process]\n  Q -->|no| E[Reject]\n  P --> F([Done])\n  E --> F",
    ]) {
      expectSound(lay(source));
    }
  });
});
