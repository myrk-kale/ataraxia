import { describe, expect, it } from "vitest";
import { SCENES, TIMES_OF_DAY, forcedTime, timeOfDay } from "./scenes";

const at = (hours: number, minutes = 0) => new Date(2026, 10, 14, hours, minutes);

describe("timeOfDay", () => {
  it("is morning from five until noon", () => {
    expect([at(5), at(8, 30), at(11, 59)].map(timeOfDay)).toEqual(["morning", "morning", "morning"]);
  });

  it("is afternoon from noon until half past five", () => {
    expect([at(12), at(15), at(17, 29)].map(timeOfDay)).toEqual(["afternoon", "afternoon", "afternoon"]);
  });

  it("is evening from half past five until nine", () => {
    expect([at(17, 30), at(19), at(20, 59)].map(timeOfDay)).toEqual(["evening", "evening", "evening"]);
  });

  it("is night from nine until five, across midnight", () => {
    expect([at(21), at(23, 59), at(0), at(3), at(4, 59)].map(timeOfDay)).toEqual([
      "night",
      "night",
      "night",
      "night",
      "night",
    ]);
  });

  it("gives every minute of the day exactly one part, in order", () => {
    const order = TIMES_OF_DAY;
    let last = -1;
    const seen = new Set<string>();
    for (let minute = 5 * 60; minute < 29 * 60; minute += 1) {
      // From five in the morning around to the next five.
      const date = at(Math.floor(minute / 60) % 24, minute % 60);
      const time = timeOfDay(date);
      const index = order.indexOf(time);
      expect(index).toBeGreaterThanOrEqual(last);
      last = index;
      seen.add(time);
    }
    expect([...seen].sort()).toEqual([...order].sort());
  });
});

describe("the pictures", () => {
  it("are four, one for each part of the day, and all different", () => {
    expect(Object.keys(SCENES).sort()).toEqual([...TIMES_OF_DAY].sort());
    expect(new Set(Object.values(SCENES).map((scene) => scene.slug)).size).toBe(4);
  });

  it("are the vendored pieces they name, and each can draw a frame", async () => {
    for (const time of TIMES_OF_DAY) {
      const scene = SCENES[time];
      const module = await scene.load();
      expect(module.meta.slug).toBe(scene.slug);
      const frame = module.default();
      expect(typeof frame).toBe("function");
      expect(frame(0)).toBeTruthy();
    }
  });
});

describe("forcedTime", () => {
  it("reads the part of the day from the address in development", () => {
    expect(forcedTime("?time=night", true)).toBe("night");
    expect(forcedTime("?x=1&time=morning", true)).toBe("morning");
  });

  it("ignores anything that is not a part of the day", () => {
    expect(forcedTime("?time=midnight", true)).toBeNull();
    expect(forcedTime("", true)).toBeNull();
  });

  it("does nothing in a built app", () => {
    expect(forcedTime("?time=night", false)).toBeNull();
  });
});
