import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Loader } from "./Loader";

const css = readFileSync(new URL("../styles/index.css", import.meta.url), "utf8");
const block = (pattern: RegExp) => pattern.exec(css)?.[0] ?? "";

describe("Loader", () => {
  it("is a status with a name, so it is read out", () => {
    const html = renderToStaticMarkup(<Loader label="Working" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Working"');
    expect(html).toContain("cg-loader");
  });

  it("is three dots", () => {
    const html = renderToStaticMarkup(<Loader label="Working" />);
    expect(html.match(/<span><\/span>/g)).toHaveLength(3);
  });

  it("is drawn in the colour of the theme, never in a fixed one", () => {
    const dots = block(/\.cg-loader > span\s*\{[^}]*\}/);
    expect(dots).toContain("background: currentColor");
    expect(dots).not.toMatch(/#[0-9a-f]{3,6}/i);
    expect(renderToStaticMarkup(<Loader label="Working" />)).toContain("text-cg-muted");
  });

  it("does not stretch across the column it sits in, which would put the dots in the middle", () => {
    const html = renderToStaticMarkup(<Loader label="Working" />);
    expect(html).toContain("self-start");
    expect(block(/\.cg-loader\s*\{[^}]*\}/)).toContain("display: inline-flex");
  });

  it("rises and settles in a wave, each dot a little after the one before", () => {
    expect(css).toMatch(/\.cg-loader > span\s*\{[^}]*animation: cg-loader-wave 0\.8s cubic-bezier\(0\.36, 0, 0\.22, 1\) infinite/);
    expect(css).toMatch(/\.cg-loader > span:nth-child\(2\)\s*\{\s*animation-delay: -0\.66s/);
    expect(css).toMatch(/\.cg-loader > span:nth-child\(3\)\s*\{\s*animation-delay: -0\.52s/);
    const keyframes = block(/@keyframes cg-loader-wave\s*\{[\s\S]*?\n\}/);
    expect(keyframes).toContain("translateY(-9px) scale(1.05)");
    expect(keyframes).toContain("translateY(3px) scale(0.78)");
    // It is the dot that moves, not the box round the three.
    expect(block(/\.cg-loader\s*\{[^}]*\}/)).not.toContain("animation");
  });

  it("holds still for people who ask for reduced motion, the dots a little faded", () => {
    const reduced = block(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.cg-loader > span[\s\S]*?\}\s*\}/);
    expect(reduced).toContain("animation: none");
    expect(reduced).toContain("opacity: 0.8");
  });
});
