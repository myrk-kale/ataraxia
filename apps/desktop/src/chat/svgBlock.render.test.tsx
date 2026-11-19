// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";
import { estimateRow, type Row } from "./rows";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><title>Three ideas</title><desc>Three boxes in a row</desc><rect class="node" x="10" y="10" width="100" height="50"/><script>alert(1)</script></svg>`;
const fence = (body: string) => `Here it is:\n\n\`\`\`svg\n${body}\n\`\`\`\n`;

let host: HTMLDivElement;
let root: Root;

const wait = (ms: number) => act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const render = (text: string) => act(() => root.render(<Markdown text={text} />));

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("an svg block in a reply", () => {
  it("is shown as an image, with a text alternative, and nothing in it runs", () => {
    render(fence(SVG));
    const image = host.querySelector("img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("alt")).toBe("Three ideas. Three boxes in a row");
    const url = image?.getAttribute("src") ?? "";
    expect(url.startsWith("data:image/svg+xml")).toBe(true);
    const markup = decodeURIComponent(url.split(",")[1] ?? "");
    expect(markup).toContain("<rect");
    expect(markup).not.toContain("<script");
    // The drawing is not in the page itself, where its styles and scripts could reach the app.
    expect(host.querySelector("svg[viewBox='0 0 400 200']")).toBeNull();
    expect(host.querySelector("figure")?.getAttribute("aria-label")).toBe("Three ideas");
  });

  it("can show its code, and go back to the picture", () => {
    render(fence(SVG));
    const press = (name: string) =>
      act(() => {
        [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(name))?.click();
      });
    press("Code");
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("code")?.textContent).toContain("<rect");
    expect(host.querySelector("code")?.textContent).not.toContain("script");
    press("Image");
    expect(host.querySelector("img")).not.toBeNull();
  });

  it("shows a placeholder while it may still be arriving, and the code with the reason once it has stopped", async () => {
    render(fence('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect'));
    expect(host.querySelector("[role=status]")?.textContent).toContain("Drawing");
    expect(host.querySelector("img")).toBeNull();
    await wait(450);
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("Could not draw this SVG: it is not a well-formed SVG.");
    expect(host.querySelector("code")?.textContent).toContain("<rect");
  });

  it("is counted as one drawing, not as lines of code, when a row's height is guessed", () => {
    const lines = Array.from({ length: 60 }, (_, index) => `<rect y="${index}"/>`).join("\n");
    const row = (text: string) =>
      ({ key: "a", after: 0, item: { kind: "message", id: "a", role: "assistant", text, turnId: "t" } }) as unknown as Row;
    expect(estimateRow(row(`\`\`\`svg\n${lines}\n\`\`\``))).toBeLessThan(estimateRow(row(`\`\`\`xml\n${lines}\n\`\`\``)) / 3);
  });
});
