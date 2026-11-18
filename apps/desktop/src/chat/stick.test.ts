import { describe, expect, it } from "vitest";
import { isUpwardKey, REATTACH_PX, stickAfterScroll } from "./stick";

describe("following the stream", () => {
  it("keeps following while the bottom is pinned and the content grows", () => {
    // A token made the text taller: the position did not move, the distance grew.
    expect(stickAfterScroll(true, 500, 500, 60)).toBe(true);
    // The pin itself moved the view down.
    expect(stickAfterScroll(true, 560, 500, 0)).toBe(true);
  });

  it("lets go at the first small move upward, even within the old 80px margin", () => {
    expect(stickAfterScroll(true, 470, 500, 40)).toBe(false);
    expect(stickAfterScroll(true, 497, 500, 30)).toBe(false);
  });

  it("stays let go while reading above, and takes hold again at the bottom", () => {
    expect(stickAfterScroll(false, 300, 300, 400)).toBe(false);
    expect(stickAfterScroll(false, 320, 300, 380)).toBe(false);
    expect(stickAfterScroll(false, 700, 680, REATTACH_PX)).toBe(true);
  });

  it("is not fooled by the browser clamping the position when the content shrinks", () => {
    expect(stickAfterScroll(true, 480, 500, 0)).toBe(true);
  });

  it("knows the keys that scroll up", () => {
    for (const key of ["PageUp", "Home", "ArrowUp"]) {
      expect(isUpwardKey(key, false)).toBe(true);
    }
    expect(isUpwardKey(" ", true)).toBe(true);
    expect(isUpwardKey(" ", false)).toBe(false);
    expect(isUpwardKey("PageDown", false)).toBe(false);
  });
});
