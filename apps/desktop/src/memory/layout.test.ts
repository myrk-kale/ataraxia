import { describe, expect, it } from "vitest";
import { layoutForce } from "./layout";

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("layoutForce", () => {
  it("places every node, and the same graph always lands the same way", () => {
    const ids = ["a", "b", "c", "d"];
    const links = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ];
    const first = layoutForce(ids, links);
    const second = layoutForce(ids, links);
    expect([...first.keys()]).toEqual(ids);
    for (const id of ids) {
      expect(first.get(id)).toEqual(second.get(id));
      expect(Number.isFinite(first.get(id)!.x)).toBe(true);
    }
  });

  it("keeps linked nodes closer than strangers and nodes apart from each other", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const placed = layoutForce(ids, [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ]);
    expect(distance(placed.get("a")!, placed.get("b")!)).toBeLessThan(distance(placed.get("a")!, placed.get("e")!));
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        expect(distance(placed.get(ids[i]!)!, placed.get(ids[j]!)!)).toBeGreaterThan(60);
      }
    }
  });

  it("leaves no two boxes overlapping, even for many nodes with no links at all", () => {
    const ids = Array.from({ length: 24 }, (_, index) => `n${index}`);
    const placed = layoutForce(ids, []);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = placed.get(ids[i]!)!;
        const b = placed.get(ids[j]!)!;
        const apart = Math.abs(a.x - b.x) >= 208 || Math.abs(a.y - b.y) >= 84;
        expect(apart, `${ids[i]} and ${ids[j]} overlap`).toBe(true);
      }
    }
  });

  it("copes with none, one, and links to nodes that are not there", () => {
    expect(layoutForce([], []).size).toBe(0);
    expect(layoutForce(["only"], []).size).toBe(1);
    const placed = layoutForce(["a", "b"], [{ source: "a", target: "ghost" }, { source: "a", target: "a" }]);
    expect(placed.size).toBe(2);
  });
});
