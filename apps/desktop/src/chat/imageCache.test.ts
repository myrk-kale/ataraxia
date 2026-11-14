import { describe, expect, it } from "vitest";
import { ImageCache } from "./imageCache";

describe("ImageCache", () => {
  it("returns what was kept", () => {
    const cache = new ImageCache(100);
    cache.set("a", "x".repeat(10));
    expect(cache.get("a")).toBe("x".repeat(10));
    expect(cache.get("missing")).toBeUndefined();
  });

  it("lets go of the picture looked at longest ago when over budget", () => {
    const cache = new ImageCache(30);
    cache.set("a", "x".repeat(10));
    cache.set("b", "y".repeat(10));
    cache.set("c", "z".repeat(10));
    cache.get("a");
    cache.set("d", "w".repeat(10));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.bytes).toBeLessThanOrEqual(30);
  });

  it("never holds more than its budget", () => {
    const cache = new ImageCache(50);
    for (let at = 0; at < 20; at += 1) {
      cache.set(`k${at}`, "x".repeat(12));
      expect(cache.bytes).toBeLessThanOrEqual(50);
    }
  });

  it("does not keep one picture bigger than the whole budget, and keeps the rest", () => {
    const cache = new ImageCache(20);
    cache.set("small", "x".repeat(5));
    cache.set("huge", "y".repeat(100));
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.get("small")).toBeDefined();
  });

  it("counts a picture once when it is set again", () => {
    const cache = new ImageCache(100);
    cache.set("a", "x".repeat(10));
    cache.set("a", "x".repeat(30));
    expect(cache.bytes).toBe(30);
    cache.clear();
    expect(cache.bytes).toBe(0);
  });
});
