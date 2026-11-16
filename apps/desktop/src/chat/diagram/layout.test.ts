import { describe, expect, it } from "vitest";
import { MARGIN, MAX_COLS, NODE_H, layoutGraph, titleColumns, wrapLabel, type Layout, type PlacedFrame, type PlacedNode } from "./layout";
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
    expect(node.h).toBe(node.lines.length + 2);
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

describe("long labels and deep charts", () => {
  it("cuts a label at spaces, and breaks a word longer than a line", () => {
    expect(wrapLabel("short", 10)).toEqual(["short"]);
    expect(wrapLabel("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(wrapLabel("abcdefghijkl mn", 5)).toEqual(["abcde", "fghij", "kl mn"]);
  });

  it("keeps a label that fits on one line in a box of three rows", () => {
    const layout = lay("flowchart TD\nA[Pythia calcula os escores das opções] --> B[Fim]");
    expect(nodeAt(layout, "A").lines).toHaveLength(1);
    expect(nodeAt(layout, "A").h).toBe(NODE_H);
    expectSound(layout);
  });

  it("gives a label longer than a line a taller box instead of cutting it off", () => {
    const text = "Valida prompt e in_minutes ou at, mais every_minutes opcional";
    const layout = lay(`flowchart TD\nA["${text}"] --> B[Fim]`);
    const box = nodeAt(layout, "A");
    expect(box.lines.length).toBeGreaterThan(1);
    expect(box.lines.join(" ")).toBe(text);
    expect(box.h).toBe(box.lines.length + 2);
    expectSound(layout);
  });

  it("draws a chain longer than fourteen steps one under the other", () => {
    const ids = Array.from({ length: 22 }, (_, i) => `N${i}`);
    const layout = lay(`flowchart TD\n${ids.join(" --> ")}`);
    expect(new Set(layout.nodes.map((n) => n.x)).size).toBe(1);
    expect(layout.nodes.map((n) => n.y)).toEqual([...layout.nodes.map((n) => n.y)].sort((a, b) => a - b));
    expectSound(layout);
  });

  it("shortens the lines of a wide chart until it fits instead of giving up", () => {
    const label = "x".repeat(38);
    const row = Array.from({ length: 8 }, (_, i) => `R --> C${i}["${label} ${i}"]`).join("\n");
    const layout = lay(`flowchart TD\n${row}`);
    expect(layout.width).toBeLessThanOrEqual(MAX_COLS);
    expect(nodeAt(layout, "C0").lines.length).toBeGreaterThan(1);
    expectSound(layout);
  });
});

describe("subgraphs", () => {
  const frameOf = (layout: Layout, id: string): PlacedFrame => layout.frames.find((f) => f.id === id)!;
  const within = (frame: PlacedFrame, node: { x: number; y: number; w: number; h: number }) =>
    node.x >= frame.x && node.x + node.w <= frame.x + frame.w && node.y >= frame.y && node.y + node.h <= frame.y + frame.h;
  const apart = (a: PlacedFrame, b: PlacedFrame) =>
    a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;

  /** What holds for any drawing with frames, on top of what holds for any drawing. */
  function expectFramesSound(layout: Layout) {
    expectSound(layout);
    for (const frame of layout.frames) {
      expect(frame.x).toBeGreaterThanOrEqual(0);
      expect(frame.y).toBeGreaterThanOrEqual(0);
      expect(frame.x + frame.w).toBeLessThanOrEqual(layout.width);
      expect(frame.y + frame.h).toBeLessThanOrEqual(layout.height);
      expect(frame.w).toBeGreaterThanOrEqual([...frame.title].length + 6);
      // No link runs over a title.
      const title = new Set(titleColumns(frame));
      for (const edge of layout.edges) {
        for (const [x, y] of edge.path) {
          expect(y === frame.y && title.has(x), `${edge.from}->${edge.to} runs over the title of ${frame.id}`).toBe(false);
        }
      }
    }
  }

  const TWO = "flowchart TD\nsubgraph one[One]\nA --> B\nend\nsubgraph two[Two]\nC --> D\nend\nB --> C\nX --> A";

  it("puts a frame round the nodes written in it, and round no others", () => {
    const layout = lay(TWO);
    expectFramesSound(layout);
    expect(layout.frames.map((f) => f.id).sort()).toEqual(["one", "two"]);
    for (const id of ["A", "B"]) {
      expect(within(frameOf(layout, "one"), nodeAt(layout, id))).toBe(true);
      expect(within(frameOf(layout, "two"), nodeAt(layout, id))).toBe(false);
    }
    for (const id of ["C", "D"]) {
      expect(within(frameOf(layout, "two"), nodeAt(layout, id))).toBe(true);
    }
    for (const frame of layout.frames) {
      expect(within(frame, nodeAt(layout, "X"))).toBe(false);
    }
    expect(apart(frameOf(layout, "one"), frameOf(layout, "two"))).toBe(true);
  });

  it("draws a subgraph inside the one it is written in, outermost frame first", () => {
    const layout = lay(
      "flowchart LR\nsubgraph outer[Outer]\nsubgraph inner[Inner]\nA --> B\nend\nC --> A\nend\nZ --> C",
    );
    expectFramesSound(layout);
    expect(layout.frames.map((f) => [f.id, f.depth])).toEqual([["outer", 0], ["inner", 1]]);
    const [outer, inner] = layout.frames as [PlacedFrame, PlacedFrame];
    expect(within(outer, inner)).toBe(true);
    for (const id of ["A", "B"]) {
      expect(within(inner, nodeAt(layout, id))).toBe(true);
    }
    expect(within(inner, nodeAt(layout, "C"))).toBe(false);
    for (const id of ["A", "B", "C"]) {
      expect(within(outer, nodeAt(layout, id))).toBe(true);
    }
    expect(within(outer, nodeAt(layout, "Z"))).toBe(false);
  });

  it("keeps the frames of side-by-side subgraphs apart when they have several layers", () => {
    const layout = lay(
      "flowchart TD\nsubgraph a[A]\nA1 --> A2 --> A3\nend\nsubgraph b[B]\nB1 --> B2 --> B3\nend\nR --> A1\nR --> B1\nA3 --> E\nB3 --> E",
    );
    expectFramesSound(layout);
    expect(apart(frameOf(layout, "a"), frameOf(layout, "b"))).toBe(true);
  });

  it("honours a subgraph's own direction when nothing outside is linked to what is inside", () => {
    const alone = lay("flowchart TD\nTop --> Mid\nsubgraph G[G]\ndirection LR\nA --> B\nend\nMid --> Low");
    expectFramesSound(alone);
    expect(nodeAt(alone, "A").y).toBe(nodeAt(alone, "B").y);
    expect(nodeAt(alone, "B").x).toBeGreaterThan(nodeAt(alone, "A").x);
  });

  it("ignores that direction when a link crosses the subgraph's edge, as Mermaid does", () => {
    const linked = lay("flowchart TD\nsubgraph G[G]\ndirection LR\nA --> B\nend\nX --> A");
    expectFramesSound(linked);
    expect(nodeAt(linked, "A").x).toBe(nodeAt(linked, "B").x);
    expect(nodeAt(linked, "B").y).toBeGreaterThan(nodeAt(linked, "A").y);
  });

  it("times the animations by how far along the flow a node is, whatever it sits in", () => {
    const layout = lay("flowchart TD\nsubgraph s[S]\nA --> B\nend\nB --> C");
    expect(["A", "B", "C"].map((id) => nodeAt(layout, id).rank)).toEqual([0, 1, 2]);
  });

  it("draws a chart of several subgraphs and links between them within the limits", () => {
    const layout = lay(SUBGRAPH_CHART);
    expectFramesSound(layout);
    expect(layout.frames).toHaveLength(4);
    expect(layout.width).toBeLessThanOrEqual(MAX_COLS);
  });
});

const SUBGRAPH_CHART = `flowchart TD
    subgraph Agente["Agente do chat"]
        AG["Claude, Codex ou OpenCode"]
    end
    subgraph API["API local"]
        direction LR
        P["POST /v1/schedules"] --> V["Valida os campos"] --> S["schedule_add"] --> DB["Grava em preferências"]
    end
    subgraph Relogio["Relógio, a cada 5 s"]
        TK["schedules_tick"] --> LV{"Agente rodando?"}
        LV -->|sim| DU{"Venceu?"}
        LV -->|não| WT["Espera"]
        DU -->|sim| EQ["enqueue"]
    end
    subgraph Fila["Fila de mensagens"]
        FQ["Fila do chat"] --> DP["dispatch"]
    end
    AG -->|curl| P
    DB -.-> TK
    EQ --> FQ
    DP --> AG
`;
