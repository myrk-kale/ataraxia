// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { MAX_SVG_CHARS, prepareSvg, svgDataUrl, svgTheme } from "./prepare";

const theme = svgTheme(() => "");

const drawing = (inner: string, attributes = 'viewBox="0 0 800 400"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><title>Map</title><desc>A small map</desc>${inner}</svg>`;

function ok(source: string) {
  const made = prepareSvg(source, theme);
  if (!made.ok) {
    throw new Error(made.reason);
  }
  return made;
}

describe("preparing an SVG an agent wrote", () => {
  it("keeps the drawing, sizes it from its viewBox and gives it the theme", () => {
    const made = ok(drawing('<rect class="node" x="10" y="10" width="100" height="50"/><text class="label" x="20" y="40">Hi</text>'));
    expect([made.width, made.height]).toEqual([800, 400]);
    expect(made.title).toBe("Map");
    expect(made.description).toBe("A small map");
    expect(made.markup).toContain("<rect");
    expect(made.markup).toContain(".node{fill:var(--tint)");
    expect(made.markup).toContain('width="800"');
    // What is copied is the drawing, not the stylesheet the app added.
    expect(made.source).toContain("<rect");
    expect(made.source).not.toContain("--tint");
  });

  it("takes a drawing that forgot its namespace, its prolog or its xlink declaration", () => {
    const made = ok('<?xml version="1.0"?>\n<svg viewBox="0 0 10 10"><defs><path id="p" d="M0 0L5 5"/></defs><use xlink:href="#p"/></svg>');
    expect(made.markup).toContain("<use");
    expect(made.markup).toContain("#p");
  });

  it("sizes a drawing that has only a width and a height, and refuses one that has neither", () => {
    const made = ok('<svg xmlns="http://www.w3.org/2000/svg" width="300px" height="150"><circle r="5"/></svg>');
    expect([made.width, made.height]).toEqual([300, 150]);
    expect(made.markup).toContain('viewBox="0 0 300 150"');
    expect(prepareSvg('<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>', theme)).toEqual({
      ok: false,
      reason: "it has no viewBox, so it has no size",
    });
  });

  it("takes out what runs, loads or embeds", () => {
    const made = ok(
      drawing(
        [
          "<script>alert(1)</script>",
          '<rect width="10" height="10" onclick="steal()" onload="x()"/>',
          '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>',
          '<image href="https://example.com/track.png" width="10" height="10"/>',
          '<a href="https://example.com"><text>link</text></a>',
          '<a href="javascript:alert(1)"><text>js</text></a>',
          '<animate attributeName="x" to="5"/>',
          '<rect style="fill:url(https://example.com/x.svg#a);stroke:url(#ok)" fill="url(http://example.com/a)"/>',
          "<style>@import url(https://example.com/a.css); .a{background:url(https://example.com/b.png)} .ok{fill:url(#g)}</style>",
        ].join(""),
      ),
    );
    for (const text of [made.markup, made.source]) {
      expect(text).not.toMatch(/script|onclick|onload|foreignObject|<image|<animate|javascript:|example\.com/i);
      expect(text).toContain("#ok");
      expect(text).toContain("url(#g)");
    }
  });

  it("refuses what is not one well-formed SVG", () => {
    for (const bad of [
      "",
      "just words",
      "<svg viewBox='0 0 1 1'><rect></svg>",
      "<div>not svg</div>",
      '<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">&a;</svg>',
    ]) {
      expect(prepareSvg(bad, theme).ok, bad).toBe(false);
    }
    expect(prepareSvg(`<svg viewBox="0 0 1 1">${"x".repeat(MAX_SVG_CHARS)}</svg>`, theme)).toEqual({
      ok: false,
      reason: "the drawing is too large",
    });
  });

  it("uses only colours that are colours when it writes the theme", () => {
    const read = (name: string) => (name === "--cg-ink" ? "#112233" : name === "--cg-tint" ? "red;}</style><script>" : "");
    const picked = svgTheme(read);
    expect(picked.ink).toBe("#112233");
    expect(picked.tint).toBe("#f4f4f1");
  });

  it("makes an image address that carries the whole drawing", () => {
    const url = svgDataUrl("<svg a='b'/>");
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.split(",")[1] ?? "")).toBe("<svg a='b'/>");
  });
});
