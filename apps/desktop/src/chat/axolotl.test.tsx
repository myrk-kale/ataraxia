import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Axolotl } from "./Axolotl";
import { AXOLOTL_ART, AXOLOTL_CLOSED_ART, AXOLOTL_CLOSED_ROWS, AXOLOTL_ROWS } from "./axolotlArt";
import { BLINK_MS, isDoubleBlink, nextBlinkDelay } from "./blink";
import { Hero } from "./Hero";

const BRAILLE = (char: string) => char >= "⠀" && char <= "⣿";

describe("axolotl art", () => {
  it("is a rectangle of braille characters", () => {
    expect(AXOLOTL_ROWS.length).toBeGreaterThan(20);
    const widths = new Set(AXOLOTL_ROWS.map((row) => [...row].length));
    expect(widths.size).toBe(1);
    for (const row of AXOLOTL_ROWS) {
      expect([...row].every(BRAILLE)).toBe(true);
    }
    expect(AXOLOTL_ART.split("\n")).toHaveLength(AXOLOTL_ROWS.length);
  });
});

describe("blinking", () => {
  it("the closed frame has the same size as the open one", () => {
    expect(AXOLOTL_CLOSED_ROWS).toHaveLength(AXOLOTL_ROWS.length);
    AXOLOTL_CLOSED_ROWS.forEach((row, index) => {
      expect([...row]).toHaveLength([...AXOLOTL_ROWS[index]].length);
      expect([...row].every(BRAILLE)).toBe(true);
    });
    expect(AXOLOTL_CLOSED_ART).not.toBe(AXOLOTL_ART);
  });

  it("only the eye area changes, so the rest of the picture does not flicker", () => {
    const changedRows: number[] = [];
    let changed = 0;
    let total = 0;
    AXOLOTL_ROWS.forEach((row, index) => {
      const closed = [...AXOLOTL_CLOSED_ROWS[index]];
      [...row].forEach((char, col) => {
        total += 1;
        if (char !== closed[col]) {
          changed += 1;
          if (!changedRows.includes(index)) {
            changedRows.push(index);
          }
        }
      });
    });
    expect(changed).toBeGreaterThan(0);
    expect(changed / total).toBeLessThan(0.03);
    // The eyes sit in the upper half and span only a few rows.
    expect(Math.max(...changedRows) - Math.min(...changedRows)).toBeLessThanOrEqual(8);
    expect(Math.max(...changedRows)).toBeLessThan(AXOLOTL_ROWS.length / 2);
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
