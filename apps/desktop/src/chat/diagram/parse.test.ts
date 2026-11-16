import { describe, expect, it } from "vitest";
import { LIMITS, parseFlowchart, type Graph } from "./parse";

function graphOf(source: string): Graph {
  const parsed = parseFlowchart(source);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return parsed.graph;
}

const reason = (source: string) => {
  const parsed = parseFlowchart(source);
  return parsed.ok ? null : parsed.reason;
};

describe("parseFlowchart", () => {
  it("reads nodes, labels and arrows in order", () => {
    const graph = graphOf("flowchart LR\n  C[Client] --> G[API Gateway]\n  G --> Q[Queue]");
    expect(graph.direction).toBe("LR");
    expect(graph.nodes.map((n) => [n.id, n.label])).toEqual([
      ["C", "Client"],
      ["G", "API Gateway"],
      ["Q", "Queue"],
    ]);
    expect(graph.edges.map((e) => [e.from, e.to])).toEqual([
      ["C", "G"],
      ["G", "Q"],
    ]);
  });

  it("takes graph and flowchart alike, and TB as TD, and TD when no direction is given", () => {
    expect(graphOf("graph TB\nA-->B").direction).toBe("TD");
    expect(graphOf("flowchart\nA-->B").direction).toBe("TD");
    expect(graphOf("flowchart RL;\nA-->B").direction).toBe("RL");
    expect(graphOf("flowchart BT\nA-->B").direction).toBe("BT");
  });

  it("reads a chain as consecutive links", () => {
    const graph = graphOf("flowchart LR\nA --> B --> C --> D");
    expect(graph.edges.map((e) => `${e.from}${e.to}`)).toEqual(["AB", "BC", "CD"]);
  });

  it("reads several statements on a line and keeps a node's first shape", () => {
    const graph = graphOf("flowchart LR\nA[One]; B(Two); A --> B");
    expect(graph.nodes.map((n) => [n.label, n.shape])).toEqual([
      ["One", "rect"],
      ["Two", "round"],
    ]);
    expect(graph.edges).toHaveLength(1);
  });

  it("knows the shapes", () => {
    const shapes = (source: string) => graphOf(`flowchart LR\n${source}`).nodes[0]!.shape;
    expect(shapes("A[x]")).toBe("rect");
    expect(shapes("A[[x]]")).toBe("rect");
    expect(shapes("A(x)")).toBe("round");
    expect(shapes("A((x))")).toBe("round");
    expect(shapes("A([x])")).toBe("round");
    expect(shapes("A[(Database)]")).toBe("round");
    expect(shapes("A{x}")).toBe("decision");
    expect(shapes("A{{x}}")).toBe("decision");
  });

  it("keeps the whole label of a cylinder without its parentheses", () => {
    expect(graphOf("flowchart LR\nD[(Database)]").nodes[0]!.label).toBe("Database");
  });

  it("reads quoted labels, which may hold brackets and arrows", () => {
    const graph = graphOf('flowchart LR\nA["a [b] --> c"] --> B');
    expect(graph.nodes[0]!.label).toBe("a [b] --> c");
    expect(graph.edges).toHaveLength(1);
  });

  it("reads link labels in both spellings and keeps them", () => {
    const bars = graphOf("flowchart LR\nA -->|yes| B\nA -->|no| C");
    expect(bars.edges.map((e) => e.label)).toEqual(["yes", "no"]);
    const inline = graphOf("flowchart LR\nA -- when ready --> B\nB -. maybe .-> C\nC == always ==> D");
    expect(inline.edges.map((e) => e.label)).toEqual(["when ready", "maybe", "always"]);
  });

  it("knows an open link has no arrowhead", () => {
    const graph = graphOf("flowchart LR\nA --- B\nB --> C\nC -.- D\nD ==> E");
    expect(graph.edges.map((e) => e.arrow)).toEqual([false, true, false, true]);
  });

  it("does not draw the same link twice, but does draw two with different labels", () => {
    expect(graphOf("flowchart LR\nA --> B\nA --> B").edges).toHaveLength(1);
    expect(graphOf("flowchart LR\nA -->|x| B\nA -->|y| B").edges).toHaveLength(2);
  });

  it("lets a later label replace an earlier one", () => {
    expect(graphOf("flowchart LR\nA --> B\nB[Named]").nodes[1]!.label).toBe("Named");
  });

  it("ignores comments and styling, which do not change the structure", () => {
    const graph = graphOf(
      "flowchart LR\n%% a comment\nA --> B %% trailing\nstyle A fill:#f9f\nclassDef x fill:#fff\nclass A x\nlinkStyle 0 stroke:red\nclick A callback",
    );
    expect(graph.nodes.map((n) => n.id)).toEqual(["A", "B"]);
    expect(graph.edges).toHaveLength(1);
  });

  it("refuses what is not a flowchart", () => {
    expect(reason("sequenceDiagram\nA->>B: hi")).toMatch(/only flowcharts/);
    expect(reason("classDiagram\nA <|-- B")).toMatch(/only flowcharts/);
    expect(reason("")).toMatch(/only flowcharts/);
  });

  it("refuses what it cannot draw faithfully instead of dropping it", () => {
    expect(reason("flowchart LR\nA & B --> C")).toMatch(/&|node/);
    expect(reason("flowchart LR\nA <--> B")).toBeTruthy();
    expect(reason("flowchart LR\nA --x B")).toBeTruthy();
    expect(reason("flowchart LR\nA[One]:::hot --> B")).toBeTruthy();
    expect(reason('flowchart LR\nA["two<br/>lines"] --> B')).toMatch(/markup/);
    expect(reason("flowchart LR\nA[unclosed --> B")).toMatch(/not closed/);
    expect(reason("flowchart LR\nA -->")).toBeTruthy();
  });

  it("refuses a diagram with no node", () => {
    expect(reason("flowchart LR")).toMatch(/no nodes/);
  });

  it("refuses what is too big, by size and by count", () => {
    expect(reason(`flowchart LR\n${"A --> B\n".repeat(2000)}`)).toMatch(/too long/);
    const many = Array.from({ length: LIMITS.nodes }, (_, i) => `N${i} --> N${i + 1}`).join("\n");
    expect(reason(`flowchart LR\n${many}`)).toMatch(/too large/);
  });

  it("shortens a label that is too long", () => {
    const label = graphOf(`flowchart LR\nA[${"x".repeat(200)}]`).nodes[0]!.label;
    expect(label.length).toBe(LIMITS.label);
    expect(label.endsWith("…")).toBe(true);
  });

  it("uses the id as the label of a bare node and of an empty label", () => {
    expect(graphOf("flowchart LR\nStart --> End").nodes.map((n) => n.label)).toEqual(["Start", "End"]);
    expect(graphOf("flowchart LR\nA[] --> B").nodes[0]!.label).toBe("A");
  });

  it("accepts ids that start with a digit, as Mermaid does", () => {
    expect(graphOf("flowchart LR\n1 --> 2").edges).toHaveLength(1);
  });
});

describe("subgraphs", () => {
  const ok = (source: string) => graphOf(source);

  it("reads a subgraph with an id and a title, quoted or not, or with only a title", () => {
    const quoted = ok('flowchart TD\nsubgraph api["The API"]\nA --> B\nend');
    expect(quoted.groups).toEqual([{ id: "api", title: "The API", parent: null, direction: null }]);
    expect(quoted.nodes.map((n) => [n.id, n.group])).toEqual([["A", "api"], ["B", "api"]]);
    expect(ok("flowchart TD\nsubgraph api [Plain title]\nA\nend").groups[0]!.title).toBe("Plain title");
    const bare = ok("flowchart TD\nsubgraph Back End\nA\nend").groups[0]!;
    expect([bare.id, bare.title]).toEqual(["Back End", "Back End"]);
  });

  it("keeps a node in the first subgraph it was written in, and in none when written outside", () => {
    const graph = ok("flowchart TD\nsubgraph one\nA\nend\nsubgraph two\nB\nend\nA --> B\nC --> A");
    expect(Object.fromEntries(graph.nodes.map((n) => [n.id, n.group]))).toEqual({ A: "one", B: "two", C: null });
  });

  it("reads subgraphs inside subgraphs, and the direction a subgraph asks for", () => {
    const graph = ok("flowchart TD\nsubgraph outer\nsubgraph inner\ndirection LR\nA --> B\nend\nC\nend");
    expect(graph.groups.map((g) => [g.id, g.parent, g.direction])).toEqual([
      ["outer", null, null],
      ["inner", "outer", "LR"],
    ]);
    expect(graph.nodes.map((n) => [n.id, n.group])).toEqual([["A", "inner"], ["B", "inner"], ["C", "outer"]]);
    expect(ok("flowchart TD\nsubgraph s\ndirection TB\nA\nend").groups[0]!.direction).toBe("TD");
  });

  it("reads the statements on one line, apart by semicolons", () => {
    const graph = ok("flowchart TD\nsubgraph s; A --> B; end; B --> C");
    expect(graph.groups).toHaveLength(1);
    expect(graph.nodes.map((n) => [n.id, n.group])).toEqual([["A", "s"], ["B", "s"], ["C", null]]);
  });

  it("still refuses what is not drawn, and says why", () => {
    expect(reason("flowchart TD\nsubgraph s\nA --> B")).toMatch(/not closed/);
    expect(reason("flowchart TD\nA --> B\nend")).toMatch(/closes no subgraph/);
    expect(reason("flowchart TD\ndirection LR\nA --> B")).toMatch(/inside a subgraph/);
    expect(reason("flowchart TD\nsubgraph s\ndirection sideways\nA\nend")).toMatch(/direction was expected/);
    expect(reason("flowchart TD\nsubgraph s\nA\nend now")).toMatch(/stand alone/);
    expect(reason("flowchart TD\nA\nsubgraph s\nend")).toMatch(/empty subgraph/);
    expect(reason("flowchart TD\nsubgraph s\nsubgraph t\nend\nA\nend")).toMatch(/empty subgraph/);
    expect(reason("flowchart TD\nsubgraph s\nA\nend\nB --> s")).toMatch(/whole subgraph/);
    expect(reason("flowchart TD\nsubgraph s\nA\nend\nsubgraph s\nB\nend")).toMatch(/same name/);
    expect(reason('flowchart TD\nsubgraph s["a<br/>b"]\nA\nend')).toMatch(/markup/);
    expect(reason("flowchart TD\nsubgraph\nA\nend")).toMatch(/needs a title/);
  });

  it("refuses subgraphs nested too deep, and too many of them", () => {
    const deep = Array.from({ length: LIMITS.depth + 1 }, (_, i) => `subgraph s${i}`).join("\n");
    expect(reason(`flowchart TD\n${deep}\nA\n${"end\n".repeat(LIMITS.depth + 1)}`)).toMatch(/nested too deep/);
    const many = Array.from({ length: LIMITS.groups + 1 }, (_, i) => `subgraph s${i}\nA${i}\nend`).join("\n");
    expect(reason(`flowchart TD\n${many}`)).toMatch(/too large/);
  });
});
