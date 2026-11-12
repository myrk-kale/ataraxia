import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Axolotl } from "./Axolotl";
import {
  AXOLOTL_CLOSED_ART,
  AXOLOTL_ART,
  AXOLOTL_ROWS,
  closeEyes,
  EYE_CELLS,
} from "./axolotlArt";
import { BLINK_MS, isDoubleBlink, nextBlinkDelay } from "./blink";
import { Hero } from "./Hero";

describe("axolotl art", () => {
  it("is a rectangle of braille characters", () => {
    expect(AXOLOTL_ROWS).toHaveLength(30);
    const widths = new Set(AXOLOTL_ROWS.map((row) => [...row].length));
    expect(widths.size).toBe(1);
    for (const row of AXOLOTL_ROWS) {
      expect([...row].every((char) => char >= "⠀" && char <= "⣿")).toBe(true);
    }
    expect(AXOLOTL_ART.split("\n")).toHaveLength(30);
  });
});

describe("blinking", () => {
  const BLANK = "\u2800";

  it("only the eye cells hold art in the open face", () => {
    for (const [row, from, to] of EYE_CELLS) {
      for (let col = from; col <= to; col += 1) {
        expect([...AXOLOTL_ROWS[row]][col]).not.toBe(BLANK);
      }
    }
  });

  it("closing the eyes changes nothing outside the eye rows and keeps the size", () => {
    const closed = closeEyes(AXOLOTL_ROWS);
    expect(closed).toHaveLength(AXOLOTL_ROWS.length);
    const eyeRows = new Set(EYE_CELLS.map(([row]) => row));
    closed.forEach((row, index) => {
      expect([...row]).toHaveLength([...AXOLOTL_ROWS[index]].length);
      if (!eyeRows.has(index)) {
        expect(row).toBe(AXOLOTL_ROWS[index]);
      }
    });
    expect(AXOLOTL_CLOSED_ART).not.toBe(AXOLOTL_ART);
  });

  it("replaces each eye with a thin lid line and clears the rest of it", () => {
    const closed = closeEyes(AXOLOTL_ROWS).map((row) => [...row]);
    expect(closed[10].slice(19, 22).join("")).toBe("\u2824\u2824\u2824");
    expect(closed[10].slice(36, 39).join("")).toBe("\u2824\u2824\u2824");
    expect(closed[9].slice(20, 23).join("")).toBe(BLANK.repeat(3));
    expect(closed[11].slice(36, 38).join("")).toBe(BLANK.repeat(2));
    // The cheek outline right next to the right eye is left alone.
    expect(closed[9].slice(42, 44).join("")).toBe([...AXOLOTL_ROWS[9]].slice(42, 44).join(""));
  });

  it("waits a few seconds between blinks and now and then blinks twice", () => {
    expect(nextBlinkDelay(0)).toBeGreaterThanOrEqual(2000);
    expect(nextBlinkDelay(0.9999)).toBeLessThanOrEqual(7000);
    expect(nextBlinkDelay(0.2)).toBeLessThan(nextBlinkDelay(0.8));
    expect(nextBlinkDelay(-3)).toBe(nextBlinkDelay(0));
    expect(nextBlinkDelay(9)).toBeLessThanOrEqual(7000);
    expect(isDoubleBlink(0.05)).toBe(true);
    expect(isDoubleBlink(0.5)).toBe(false);
    expect(BLINK_MS).toBeGreaterThan(80);
    expect(BLINK_MS).toBeLessThan(300);
  });
});

describe("Axolotl", () => {
  it("floats, and is decorative so assistive technology skips it", () => {
    const html = renderToStaticMarkup(<Axolotl />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("cg-axolotl");
    expect(html).toContain(AXOLOTL_ROWS[0]);
  });

  it("starts with its eyes open and lets clicks reach the waves behind it", () => {
    const html = renderToStaticMarkup(<Axolotl />);
    expect(html).toContain('data-eyes="open"');
    expect(html.match(/data-wave-surface/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Hero", () => {
  it("shows the axolotl above the prompt instead of the old asterisk mark", () => {
    const html = renderToStaticMarkup(<Hero contextLabel="repo · main" />);
    expect(html).toContain("cg-axolotl");
    expect(html).toContain("What shall we build?");
    expect(html).not.toContain("✳");
  });
});
