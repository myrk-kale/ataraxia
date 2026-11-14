import { describe, expect, it } from "vitest";
import { STYLES, STYLE_NAMES } from "./glyphs";
import { K } from "./palette";
import { buildScene, cachedScene, type Scene } from "./scene";

function sceneOf(source: string, style: (typeof STYLE_NAMES)[number] = "unicode"): Scene {
  const built = buildScene(source, style);
  if (!built.ok) {
    throw new Error(built.reason);
  }
  return built.scene;
}

describe("buildScene", () => {
  it("draws two boxes and the arrow between them, exactly", () => {
    expect(sceneOf("flowchart LR\nA[Hi] --> B[Yo]").text.split("\n")).toEqual([
      "  ┌──────┐        ┌──────┐",
      "  │  Hi  │───────►│  Yo  │",
      "  └──────┘        └──────┘",
    ]);
  });

  it("draws the same shape in every style, with that style's pieces", () => {
    for (const name of STYLE_NAMES) {
      const text = sceneOf("flowchart LR\nA[Hi] --> B[Yo]", name).text;
      expect(text).toContain(STYLES[name].tl);
      expect(text).toContain(STYLES[name].br);
      expect(text).toContain("Hi");
    }
    const ascii = sceneOf("flowchart LR\nA[Hi] --> B[Yo]", "ascii").text;
    expect(ascii).toContain(">");
    expect([...ascii].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });

  it("rounds the corners of a round node, and points the sides of a decision", () => {
    const round = sceneOf("flowchart LR\nA(Hi)", "unicode").text;
    expect(round).toContain("╭");
    expect(round).toContain("╯");
    const decision = sceneOf("flowchart LR\nQ{Ok?}", "unicode").text;
    expect(decision).toContain("<");
    expect(decision).toContain(">");
  });

  it("points the arrowhead the way the line arrives, and leaves an open link without one", () => {
    expect(sceneOf("flowchart LR\nA --> B").text).toContain("►");
    expect(sceneOf("flowchart RL\nA --> B").text).toContain("◄");
    expect(sceneOf("flowchart TD\nA --> B").text).toContain("▼");
    expect(sceneOf("flowchart BT\nA --> B").text).toContain("▲");
    const open = sceneOf("flowchart LR\nA --- B").text;
    expect(open).not.toMatch(/[►◄▼▲]/);
  });

  it("writes a link label in the line", () => {
    const text = sceneOf("flowchart LR\nA -->|accepted| B").text;
    expect(text).toMatch(/─+ accepted ─+►/);
  });

  it("joins lines that meet with a corner or a tee", () => {
    const text = sceneOf("flowchart LR\nR --> A\nR --> B\nR --> C", "unicode").text;
    expect(text).toMatch(/[┬┤├┴┼┘└┐┌]/);
  });

  it("gives every drawn cell a colour class and every empty cell none", () => {
    const scene = sceneOf("flowchart LR\nA[One] --> B[Two]");
    for (let i = 0; i < scene.baseGlyph.length; i += 1) {
      expect(scene.baseGlyph[i] === 0).toBe(scene.baseCls[i] === K.none);
    }
  });

  it("lists each node's cells: the box, the label, and all of it", () => {
    const scene = sceneOf("flowchart LR\nA[One]");
    const node = scene.nodes[0]!;
    expect(node.labelCells).toHaveLength(3);
    expect(node.border).toHaveLength(2 * node.w + 2 * (node.h - 2));
    expect(new Set(node.border).size).toBe(node.border.length);
    expect(node.all).toHaveLength(node.border.length + node.labelCells.length);
    for (const cell of node.all) {
      expect(scene.baseGlyph[cell]).not.toBe(0);
    }
  });

  it("walks each line from its source to its target, ending on the arrowhead", () => {
    const scene = sceneOf("flowchart LR\nA --> B");
    const edge = scene.edges[0]!;
    expect(edge.cells.length).toBeGreaterThan(2);
    expect(scene.baseCls[edge.cells.at(-1)!]).toBe(K.arrow);
    expect(scene.baseCls[edge.cells[0]!]).toBe(K.edge);
  });

  it("orders the nodes the way the flow goes", () => {
    const scene = sceneOf("flowchart LR\nA --> B --> C\nA --> D");
    expect(scene.order.map((n) => n.id).slice(0, 1)).toEqual(["A"]);
    expect(scene.order.at(-1)!.rank).toBe(2);
  });

  it("describes the diagram in words", () => {
    const scene = sceneOf("flowchart LR\nC[Client] --> G[Gateway]\nG -->|ok| Q[Queue]\nZ[Lonely]");
    expect(scene.alt).toBe("Flowchart, left to right. Client to Gateway; Gateway to Queue (ok). Not linked: Lonely.");
  });

  it("refuses what it cannot draw, saying why", () => {
    for (const source of ["sequenceDiagram\nA->>B: hi", "flowchart LR\nsubgraph x\nA-->B\nend", "flowchart LR\nA[日本語] --> B"]) {
      const built = buildScene(source, "unicode");
      expect(built.ok).toBe(false);
    }
  });
});

describe("cachedScene", () => {
  it("lays a diagram out once and hands back the same scene", () => {
    const source = "flowchart LR\nA --> B";
    expect(cachedScene(source, "rounded")).toBe(cachedScene(source, "rounded"));
    expect(cachedScene(source, "rounded")).not.toBe(cachedScene(source, "ascii"));
  });

  it("keeps a bounded number", () => {
    const first = cachedScene("flowchart LR\nA0 --> B", "rounded");
    for (let i = 1; i < 40; i += 1) {
      cachedScene(`flowchart LR\nA${i} --> B`, "rounded");
    }
    expect(cachedScene("flowchart LR\nA0 --> B", "rounded")).not.toBe(first);
  });
});
