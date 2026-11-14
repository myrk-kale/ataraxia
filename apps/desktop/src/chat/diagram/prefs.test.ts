// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFS, parsePrefs, resetDiagramPrefs, setDiagramPrefs } from "./prefs";

describe("parsePrefs", () => {
  it("gives the defaults for nothing, and for what is not JSON or not an object", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("not json")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("42")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("null")).toEqual(DEFAULT_PREFS);
  });

  it("keeps what is valid and defaults only what is not", () => {
    expect(parsePrefs(JSON.stringify({ effect: "typing", loop: false, style: "double" }))).toEqual({
      effect: "typing",
      loop: false,
      style: "double",
    });
    expect(parsePrefs(JSON.stringify({ effect: "bogus", loop: "yes", style: "heavy" }))).toEqual({
      ...DEFAULT_PREFS,
      style: "heavy",
    });
  });

  it("allows the animation to be turned off", () => {
    expect(parsePrefs(JSON.stringify({ effect: "none" })).effect).toBe("none");
  });

  it("defaults to data flowing along the links, repeated, with square corners (so round nodes stay the round ones)", () => {
    expect(DEFAULT_PREFS).toEqual({ effect: "flow", loop: true, style: "unicode" });
  });
});

describe("setDiagramPrefs", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetDiagramPrefs();
  });

  it("keeps a change across a reload and leaves the other settings alone", () => {
    setDiagramPrefs({ style: "ascii" });
    setDiagramPrefs({ loop: false });
    resetDiagramPrefs();
    expect(parsePrefs(window.localStorage.getItem("ataraxia.diagram"))).toEqual({ ...DEFAULT_PREFS, style: "ascii", loop: false });
  });

  it("ignores a value that is not valid", () => {
    setDiagramPrefs({ effect: "bogus" as never });
    expect(parsePrefs(window.localStorage.getItem("ataraxia.diagram")).effect).toBe(DEFAULT_PREFS.effect);
  });
});
