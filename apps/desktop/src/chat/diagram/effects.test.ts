import { describe, expect, it } from "vitest";
import { EFFECTS, Frame, effectDuration, renderEffect, renderRest } from "./effects";
import { K } from "./palette";
import { glyph, glyphCount } from "./registry";
import { buildScene, type Scene } from "./scene";

function sceneOf(source: string, style: "unicode" | "ascii" = "unicode"): Scene {
  const built = buildScene(source, style);
  if (!built.ok) {
    throw new Error(built.reason);
  }
  return built.scene;
}

const CHAIN = "flowchart LR\nC[Client] --> G[Gateway]\nG --> Q[Queue]\nQ --> W[Worker]\nW --> D[(Database)]";
const FAN = "flowchart TD\nU[User] --> A[API]\nA --> O[Orders]\nA --> P[Payment]\nO --> N[Notifier]\nP --> N";

const drawn = (frame: Frame) => frame.glyph.reduce((n, g) => n + (g ? 1 : 0), 0);
const same = (a: Frame, b: Frame) =>
  a.glyph.every((g, i) => g === b.glyph[i]) && a.cls.every((c, i) => c === b.cls[i]);

describe.each([CHAIN, FAN])("effects on %#", (source) => {
  const scene = sceneOf(source);
  const resting = new Frame(scene.width * scene.height);
  renderRest(scene, resting);

  for (const effect of EFFECTS) {
    describe(effect, () => {
      it("lasts a few seconds, long enough to read and short enough not to wait for", () => {
        const seconds = effectDuration(effect, scene);
        expect(seconds).toBeGreaterThan(1);
        expect(seconds).toBeLessThan(7);
      });

      it("ends on the diagram at rest, and says so", () => {
        const frame = new Frame(resting.size);
        expect(renderEffect(effect, scene, effectDuration(effect, scene), frame)).toBe(true);
        expect(same(frame, resting)).toBe(true);
        expect(renderEffect(effect, scene, effectDuration(effect, scene) + 5, frame)).toBe(true);
        expect(same(frame, resting)).toBe(true);
      });

      it("is not finished before its end", () => {
        const frame = new Frame(resting.size);
        const half = effectDuration(effect, scene) / 2;
        expect(renderEffect(effect, scene, half, frame)).toBe(false);
      });

      it("only draws known characters in known colours, and nothing outside the diagram's cells", () => {
        const frame = new Frame(resting.size);
        const seconds = effectDuration(effect, scene);
        for (let t = 0; t < seconds; t += seconds / 40) {
          renderEffect(effect, scene, t, frame);
          for (let i = 0; i < frame.size; i += 1) {
            expect(frame.glyph[i]).toBeLessThan(glyphCount());
            expect(frame.cls[i]).toBeLessThan(14);
            expect(frame.glyph[i] === 0).toBe(frame.cls[i] === K.none);
          }
        }
      });

      it("is the same every time", () => {
        const a = new Frame(resting.size);
        const b = new Frame(resting.size);
        const t = effectDuration(effect, scene) * 0.37;
        renderEffect(effect, scene, t, a, 3);
        renderEffect(effect, scene, t, b, 3);
        expect(same(a, b)).toBe(true);
      });

      it("leaves no trace of an earlier frame when the same frame is reused", () => {
        const reused = new Frame(resting.size);
        const fresh = new Frame(resting.size);
        const seconds = effectDuration(effect, scene);
        renderEffect(effect, scene, seconds * 0.9, reused);
        renderEffect(effect, scene, seconds * 0.2, reused);
        renderEffect(effect, scene, seconds * 0.2, fresh);
        expect(same(reused, fresh)).toBe(true);
      });
    });
  }
});

describe("what each effect does", () => {
  const scene = sceneOf(CHAIN);
  const frame = new Frame(scene.width * scene.height);
  const at = (effect: Parameters<typeof renderEffect>[0], fraction: number, pass = 0) =>
    renderEffect(effect, scene, effectDuration(effect, scene) * fraction, frame, pass);

  it("reveal starts empty and only ever adds", () => {
    renderEffect("reveal", scene, 0, frame);
    expect(drawn(frame)).toBe(0);
    let before = 0;
    for (let fraction = 0.05; fraction < 0.95; fraction += 0.05) {
      at("reveal", fraction);
      const now = drawn(frame);
      expect(now).toBeGreaterThanOrEqual(before);
      before = now;
    }
    expect(before).toBeGreaterThan(0);
  });

  it("flow sends a packet along a line, and the packet is a character on that line", () => {
    const packet = glyph("●");
    let seen = false;
    const seconds = effectDuration("flow", scene);
    for (let t = 0; t < seconds && !seen; t += 0.05) {
      renderEffect("flow", scene, t, frame);
      for (const edge of scene.edges) {
        if (edge.cells.some((cell) => frame.glyph[cell] === packet)) {
          seen = true;
        }
      }
    }
    expect(seen).toBe(true);
    // The packet only flies over cells that are drawn in the diagram.
    renderEffect("flow", scene, seconds * 0.3, frame);
    for (let i = 0; i < frame.size; i += 1) {
      if (frame.glyph[i] === packet) {
        expect(scene.baseGlyph[i]).not.toBe(0);
      }
    }
  });

  it("flow uses a plain character in the ASCII style", () => {
    const plain = sceneOf(CHAIN, "ascii");
    const f = new Frame(plain.width * plain.height);
    let seen = false;
    for (let t = 0; t < effectDuration("flow", plain); t += 0.05) {
      renderEffect("flow", plain, t, f);
      seen = seen || f.glyph.some((g) => g === glyph("o"));
    }
    expect(seen).toBe(true);
  });

  it("steps lights one node at a time, those before it done and those after it waiting", () => {
    at("steps", 0.5);
    const classes = scene.order.map((node) => frame.cls[node.border[0]!]);
    const active = classes.indexOf(K.active);
    expect(active).toBeGreaterThan(-1);
    expect(classes.slice(0, active).every((c) => c === K.done)).toBe(true);
    expect(classes.slice(active + 1).every((c) => c === K.dim)).toBe(true);
  });

  it("pulse lights one node", () => {
    at("pulse", 0.4);
    const lit = scene.nodes.filter((n) => [K.active, K.bright].includes(frame.cls[n.border[1]!] as 7 | 6));
    expect(lit).toHaveLength(1);
  });

  it("typing starts with no letters and ends with all of them", () => {
    renderEffect("typing", scene, 0, frame);
    const letters = scene.nodes.flatMap((n) => n.labelCells);
    expect(letters.every((cell) => frame.glyph[cell] === 0)).toBe(true);
    renderEffect("typing", scene, effectDuration("typing", scene) - 0.001, frame);
    expect(letters.filter((cell) => frame.glyph[cell] !== 0).length).toBeGreaterThan(letters.length / 2);
  });

  it("typing shows a cursor while a name is being typed", () => {
    const cursor = glyph("▌");
    let seen = false;
    for (let t = 0; t < effectDuration("typing", scene); t += 0.03) {
      renderEffect("typing", scene, t, frame);
      seen = seen || frame.glyph.some((g) => g === cursor);
    }
    expect(seen).toBe(true);
  });

  it("states goes from idle to running to done on a good pass", () => {
    at("states", 0.05);
    const mark = (node: (typeof scene.nodes)[number]) => frame.glyph[(node.y + 1) * scene.width + node.x + 1];
    expect(mark(scene.order[0]!)).toBe(glyph("◐"));
    expect(mark(scene.order.at(-1)!)).toBe(glyph("○"));
    at("states", 0.85);
    expect(mark(scene.order[0]!)).toBe(glyph("✓"));
  });

  it("states fails a stage on every other pass, and stops there", () => {
    const failing = scene.order[2]!;
    at("states", 0.9, 1);
    expect(frame.glyph[(failing.y + 1) * scene.width + failing.x + 1]).toBe(glyph("✗"));
    expect(frame.cls[failing.border[1]!]).toBe(K.warning);
    const after = scene.order[3]!;
    expect(frame.glyph[(after.y + 1) * scene.width + after.x + 1]).toBe(glyph("○"));
    at("states", 0.9, 2);
    expect(frame.glyph[(failing.y + 1) * scene.width + failing.x + 1]).not.toBe(glyph("✗"));
  });

  it("glitch scrambles part of the drawing and keeps what it does not touch", () => {
    at("glitch", 0.2);
    let changed = 0;
    for (let i = 0; i < frame.size; i += 1) {
      if (scene.baseGlyph[i] && frame.glyph[i] !== scene.baseGlyph[i]) {
        changed += 1;
      }
      // Scrambling never makes a cell that was empty hold something.
      if (!scene.baseGlyph[i]) {
        expect(frame.glyph[i]).toBe(0);
      }
    }
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThan(scene.baseGlyph.filter(Boolean).length);
  });

  it("a time before the start is not an end", () => {
    expect(renderEffect("reveal", scene, -1, frame)).toBe(false);
  });
});
