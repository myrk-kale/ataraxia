import { describe, expect, it } from "vitest";
import {
  BASE_SIZE, DEFAULT_PET, MARGIN, STORAGE_KEY, loadPet, nudge, placement, positionAt, sanitize, savePet, sizeOf,
} from "./config";

describe("what is stored of the companion", () => {
  it("starts as the default when nothing, or nothing readable, is stored", () => {
    expect(loadPet({ getItem: () => null })).toEqual(DEFAULT_PET);
    expect(loadPet({ getItem: () => "{not json" })).toEqual(DEFAULT_PET);
    expect(loadPet(null)).toEqual(DEFAULT_PET);
    expect(sanitize(42)).toEqual(DEFAULT_PET);
    expect(sanitize(null)).toEqual(DEFAULT_PET);
  });

  it("keeps what is valid and drops what is not, field by field", () => {
    const config = sanitize({
      mode: "mini", species: "robot", name: "  Bolt   the   bot  ", color: "#ABCDEF", accessory: "crown", scale: 1.46,
      position: { x: 0.25, y: 2 }, image: null, extra: "ignored",
    });
    expect(config).toEqual({ mode: "mini", species: "robot", name: "Bolt the bot", color: "#abcdef", accessory: "crown", scale: 1.5, position: { x: 0.25, y: 1 }, image: null });
    const bad = sanitize({ mode: "huge", species: "dragon", name: "   ", color: "red", accessory: "wings", scale: "big", position: { x: "a", y: 1 } });
    expect(bad).toEqual(DEFAULT_PET);
  });

  it("holds the size and the name to their limits", () => {
    expect(sanitize({ scale: 0.1 }).scale).toBe(0.6);
    expect(sanitize({ scale: 9 }).scale).toBe(2);
    expect(sanitize({ scale: Number.NaN }).scale).toBe(1);
    expect(sanitize({ name: "x".repeat(80) }).name).toHaveLength(24);
  });

  it("takes only a small picture that is a picture", () => {
    const ok = "data:image/png;base64,iVBORw0KGgo=";
    expect(sanitize({ image: ok }).image).toBe(ok);
    expect(sanitize({ image: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }).image).toBeNull();
    expect(sanitize({ image: "https://example.com/pet.png" }).image).toBeNull();
    expect(sanitize({ image: "data:text/html;base64,PGI+" }).image).toBeNull();
    expect(sanitize({ image: `data:image/png;base64,${"A".repeat(500_000)}` }).image).toBeNull();
  });

  it("is saved and read back as it was", () => {
    const data: Record<string, string> = {};
    const config = { ...DEFAULT_PET, species: "cat" as const, name: "Miso", position: { x: 0.4, y: 0.6 } };
    savePet(config, { setItem: (key, value) => void (data[key] = value) });
    expect(Object.keys(data)).toEqual([STORAGE_KEY]);
    expect(loadPet({ getItem: (key) => data[key] ?? null })).toEqual(config);
    expect(() => savePet(config, { setItem: () => { throw new Error("full"); } })).not.toThrow();
  });
});

describe("where it stands", () => {
  const view = { width: 1000, height: 700 };
  const size = 100;

  it("starts in the bottom right corner, a margin from the edges", () => {
    expect(placement(null, view, size)).toEqual({ left: 1000 - size - MARGIN, top: 700 - size - MARGIN });
    expect(placement({ x: 0, y: 0 }, view, size)).toEqual({ left: MARGIN, top: MARGIN });
  });

  it("turns where the pointer put it into a position, and back to the same place", () => {
    const position = positionAt(400, 300, view, size);
    const back = placement(position, view, size);
    expect(back.left).toBeCloseTo(400, 5);
    expect(back.top).toBeCloseTo(300, 5);
  });

  it("never lets it out of the window, whatever the pointer does", () => {
    expect(positionAt(-500, -500, view, size)).toEqual({ x: 0, y: 0 });
    expect(positionAt(5000, 5000, view, size)).toEqual({ x: 1, y: 1 });
    const out = placement(positionAt(9999, 9999, view, size), view, size);
    expect(out.left + size + MARGIN).toBeLessThanOrEqual(view.width);
    expect(out.top + size + MARGIN).toBeLessThanOrEqual(view.height);
  });

  it("stays where it is relative to the window when the window is resized", () => {
    const position = { x: 0.5, y: 0.5 };
    const small = placement(position, { width: 600, height: 500 }, size);
    const big = placement(position, { width: 1400, height: 900 }, size);
    expect(big.left).toBeGreaterThan(small.left);
    // A window too small for it puts it at the margin instead of off screen.
    expect(placement(position, { width: 50, height: 50 }, size)).toEqual({ left: MARGIN, top: MARGIN });
    expect(positionAt(10, 10, { width: 50, height: 50 }, size)).toEqual({ x: 0, y: 0 });
  });

  it("moves by the arrow keys' steps and stops at the edge", () => {
    const start = { x: 0.5, y: 0.5 };
    const moved = nudge(start, 12, 0, view, size);
    expect(placement(moved, view, size).left - placement(start, view, size).left).toBeCloseTo(12, 5);
    expect(nudge({ x: 1, y: 1 }, 500, 500, view, size)).toEqual({ x: 1, y: 1 });
    expect(nudge(null, -5000, -5000, view, size)).toEqual({ x: 0, y: 0 });
  });

  it("is as large as its scale says", () => {
    expect(sizeOf({ scale: 1 })).toBe(BASE_SIZE);
    expect(sizeOf({ scale: 2 })).toBe(BASE_SIZE * 2);
    expect(sizeOf({ scale: 0.6 })).toBe(53);
  });
});
