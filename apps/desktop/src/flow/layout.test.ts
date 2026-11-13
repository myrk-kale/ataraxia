import { describe, expect, it } from "vitest";
import { flowDirection, layoutGraph } from "./layout";

describe("flow layout", () => {
  it("lays a chain out left to right", () => {
    const placed = layoutGraph(["a", "b", "c"], [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ]);
    expect(placed.get("a")!.x).toBeLessThan(placed.get("b")!.x);
    expect(placed.get("b")!.x).toBeLessThan(placed.get("c")!.x);
  });

  it("puts a node after its deepest predecessor", () => {
    const placed = layoutGraph(["a", "b", "c"], [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "a", target: "c" },
    ]);
    expect(placed.get("c")!.layer).toBe(2);
  });

  it("terminates on cycles and self loops", () => {
    const placed = layoutGraph(["a", "b"], [
      { source: "a", target: "b" },
      { source: "b", target: "a" },
      { source: "a", target: "a" },
    ]);
    expect(placed.size).toBe(2);
    expect(placed.get("a")!.layer).toBe(0);
    expect(placed.get("b")!.layer).toBe(1);
  });

  it("places disconnected nodes and ignores edges to nodes that do not exist", () => {
    const placed = layoutGraph(["a", "b", "lonely"], [
      { source: "a", target: "b" },
      { source: "a", target: "ghost" },
    ]);
    expect(placed.has("lonely")).toBe(true);
    expect(placed.size).toBe(3);
    const spots = [...placed.values()].map((spot) => `${spot.x},${spot.y}`);
    expect(new Set(spots).size).toBe(3);
  });

  it("runs a long chain top to bottom when it would not fit across", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const edges = ids.slice(1).map((target, index) => ({ source: ids[index]!, target }));
    expect(flowDirection(6, 1100)).toBe("down");
    expect(flowDirection(3, 1100)).toBe("across");
    const placed = layoutGraph(ids, edges, "down");
    expect(placed.get("a")!.y).toBeLessThan(placed.get("b")!.y);
    expect(placed.get("a")!.x).toBe(placed.get("f")!.x);
  });

  it("separates siblings vertically", () => {
    const placed = layoutGraph(["root", "x", "y"], [
      { source: "root", target: "x" },
      { source: "root", target: "y" },
    ]);
    expect(placed.get("x")!.y).not.toBe(placed.get("y")!.y);
    expect(placed.get("x")!.x).toBe(placed.get("y")!.x);
  });
});
