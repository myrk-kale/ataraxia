import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Axolotl } from "./Axolotl";
import { AXOLOTL_ART, AXOLOTL_ROWS } from "./axolotlArt";
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

describe("Axolotl", () => {
  it("floats, and is decorative so assistive technology skips it", () => {
    const html = renderToStaticMarkup(<Axolotl />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("cg-axolotl");
    expect(html).toContain(AXOLOTL_ROWS[0]);
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
