import { describe, expect, it, vi } from "vitest";
import { Frame, effectDuration } from "./effects";
import { Player } from "./player";
import { buildScene, type Scene } from "./scene";

function sceneOf(source = "flowchart LR\nA[One] --> B[Two] --> C[Three]"): Scene {
  const built = buildScene(source, "unicode");
  if (!built.ok) {
    throw new Error(built.reason);
  }
  return built.scene;
}

/** A clock the test turns by hand, standing in for the animation frames. */
function clock() {
  const listeners = new Set<(now: number) => void>();
  return {
    subscribe: (listener: (now: number) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    count: () => listeners.size,
    at(now: number) {
      [...listeners].forEach((listener) => listener(now));
    },
    run(seconds: number, from = 1000, step = 16) {
      let now = from;
      this.at(now);
      for (let t = 0; t < seconds * 1000; t += step) {
        now += step;
        this.at(now);
      }
      return now;
    },
  };
}

let counter = 0;
function make(overrides: { draw?: () => boolean; scene?: Scene; onChange?: (state: string) => void } = {}) {
  const scene = overrides.scene ?? sceneOf();
  const tick = clock();
  const draw = vi.fn(overrides.draw ?? (() => true));
  const onFail = vi.fn();
  const player = new Player({
    scene,
    frame: new Frame(scene.width * scene.height),
    key: `test-${(counter += 1)}`,
    draw,
    onFail,
    onChange: overrides.onChange,
    subscribe: tick.subscribe,
  });
  return { player, tick, draw, onFail, scene };
}

describe("Player", () => {
  it("does nothing while the diagram is out of view, except being ready to draw it", () => {
    const { player, tick, draw } = make();
    player.configure("reveal", false, false);
    expect(tick.count()).toBe(0);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("plays one cycle when the diagram comes into view, then stops listening", () => {
    const { player, tick, scene } = make();
    player.configure("reveal", false, false);
    player.setVisible(true);
    expect(tick.count()).toBe(1);
    tick.run(effectDuration("reveal", scene) + 0.5);
    expect(tick.count()).toBe(0);
    expect(player.running).toBe(false);
  });

  it("ends on the diagram at rest, drawn once more", () => {
    const { player, tick, draw, scene } = make();
    player.configure("reveal", false, false);
    player.setVisible(true);
    tick.run(effectDuration("reveal", scene) + 0.5);
    const last = draw.mock.calls.length;
    tick.run(2);
    expect(draw.mock.calls.length).toBe(last);
  });

  it("draws at most about thirty frames a second", () => {
    const { player, tick, draw } = make();
    player.configure("flow", true, false);
    player.setVisible(true);
    draw.mockClear();
    tick.run(1, 1000, 8);
    expect(draw.mock.calls.length).toBeLessThanOrEqual(36);
    expect(draw.mock.calls.length).toBeGreaterThan(20);
  });

  it("does not play again once it has played, when it comes back into view", () => {
    const { player, tick, scene } = make();
    player.configure("reveal", false, false);
    player.setVisible(true);
    tick.run(effectDuration("reveal", scene) + 0.5);
    player.setVisible(false);
    player.setVisible(true);
    expect(tick.count()).toBe(0);
  });

  it("plays again when asked to", () => {
    const { player, tick, scene } = make();
    player.configure("reveal", false, false);
    player.setVisible(true);
    tick.run(effectDuration("reveal", scene) + 0.5);
    player.replay();
    expect(tick.count()).toBe(1);
  });

  it("pauses when it leaves the view and goes on from where it was", () => {
    const { player, tick, draw } = make();
    player.configure("flow", true, false);
    player.setVisible(true);
    tick.run(0.5);
    player.setVisible(false);
    expect(tick.count()).toBe(0);
    draw.mockClear();
    tick.run(1);
    expect(draw).not.toHaveBeenCalled();
    player.setVisible(true);
    expect(tick.count()).toBe(1);
  });

  it("keeps going in a loop while in view, and only then", () => {
    const { player, tick, scene } = make();
    player.configure("flow", true, false);
    player.setVisible(true);
    tick.run(effectDuration("flow", scene) * 3);
    expect(tick.count()).toBe(1);
    player.setVisible(false);
    expect(tick.count()).toBe(0);
  });

  it("does not jump ahead after a long pause between two frames", () => {
    const { player, tick, scene } = make();
    player.configure("reveal", false, false);
    player.setVisible(true);
    tick.at(1000);
    tick.at(1016);
    tick.at(1016 + 60_000);
    // A minute passed but only a tenth of a second of the animation did.
    expect(tick.count()).toBe(1);
    expect(effectDuration("reveal", scene)).toBeGreaterThan(0.2);
  });

  it("never animates with reduced motion, or with the animation off, or for another effect it does not know", () => {
    for (const [effect, still] of [["reveal", true], ["none", false]] as const) {
      const { player, tick } = make();
      player.configure(effect, false, still);
      player.setVisible(true);
      expect(tick.count()).toBe(0);
    }
  });

  it("starts over when the effect is changed", () => {
    const { player, tick } = make();
    player.configure("reveal", false, false);
    player.setVisible(true);
    player.configure("steps", false, false);
    expect(tick.count()).toBe(1);
    player.configure("none", false, false);
    expect(tick.count()).toBe(0);
  });

  it("says so when a frame cannot be drawn, and stops", () => {
    const { player, tick, onFail } = make({ draw: () => false });
    player.configure("reveal", false, false);
    player.setVisible(true);
    tick.run(0.2);
    expect(onFail).toHaveBeenCalled();
    expect(tick.count()).toBe(0);
  });

  it("stops for good once it is let go", () => {
    const { player, tick } = make();
    player.configure("flow", true, false);
    player.setVisible(true);
    player.dispose();
    expect(tick.count()).toBe(0);
    player.setVisible(false);
    player.setVisible(true);
    expect(tick.count()).toBe(0);
  });

  describe("pausing", () => {
    it("holds the animation where it is, and a held animation costs nothing", () => {
      const { player, tick, draw } = make();
      player.configure("flow", true, false);
      player.setVisible(true);
      tick.run(0.4);
      player.pause();
      expect(player.state).toBe("paused");
      expect(tick.count()).toBe(0);
      draw.mockClear();
      tick.run(2);
      expect(draw).not.toHaveBeenCalled();
    });

    it("goes on from where it was when resumed", () => {
      const { player, tick } = make();
      player.configure("flow", true, false);
      player.setVisible(true);
      tick.run(0.4);
      player.pause();
      player.resume();
      expect(player.state).toBe("playing");
      expect(tick.count()).toBe(1);
    });

    it("stays held when it leaves the view and comes back, showing the moment it was held at", () => {
      const { player, tick, draw } = make();
      player.configure("flow", true, false);
      player.setVisible(true);
      tick.run(0.4);
      player.pause();
      player.setVisible(false);
      draw.mockClear();
      player.setVisible(true);
      expect(player.state).toBe("paused");
      expect(tick.count()).toBe(0);
      expect(draw).toHaveBeenCalledTimes(1);
    });

    it("is what a click does: hold it, let it go, and play it again once it is over", () => {
      const { player, tick, scene } = make();
      player.configure("reveal", false, false);
      player.setVisible(true);
      player.toggle();
      expect(player.state).toBe("paused");
      player.toggle();
      expect(player.state).toBe("playing");
      tick.run(effectDuration("reveal", scene) + 0.5);
      expect(player.state).toBe("rest");
      player.toggle();
      expect(player.state).toBe("playing");
    });

    it("does not hold an animation that is not playing, or that is off, or that reduced motion keeps still", () => {
      for (const [effect, still] of [["none", false], ["flow", true]] as const) {
        const { player } = make();
        player.configure(effect, true, still);
        player.setVisible(true);
        player.pause();
        expect(player.state).toBe("rest");
      }
    });

    it("plays an animation that is chosen while another is held", () => {
      const { player, tick } = make();
      player.configure("flow", true, false);
      player.setVisible(true);
      player.pause();
      player.configure("steps", true, false);
      expect(player.state).toBe("playing");
      expect(tick.count()).toBe(1);
    });

    it("plays again from the start when asked, even if held", () => {
      const { player, tick } = make();
      player.configure("flow", true, false);
      player.setVisible(true);
      player.pause();
      player.replay();
      expect(player.state).toBe("playing");
      expect(tick.count()).toBe(1);
    });

    it("tells each change of state once, and nothing when nothing changed", () => {
      const seen: string[] = [];
      const { player, tick, scene } = make({ onChange: (state) => seen.push(state) });
      player.configure("reveal", false, false);
      player.setVisible(true);
      player.pause();
      player.pause();
      player.resume();
      tick.run(effectDuration("reveal", scene) + 0.5);
      expect(seen).toEqual(["playing", "paused", "playing", "rest"]);
    });

    it("draws the moment it was held at when asked to repaint", () => {
      const { player, tick, draw } = make();
      player.configure("flow", true, false);
      player.setVisible(true);
      tick.run(0.4);
      player.pause();
      draw.mockClear();
      player.repaint();
      expect(draw).toHaveBeenCalledTimes(1);
    });
  });
});

