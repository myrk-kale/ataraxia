import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SelectionMenu } from "./SelectionMenu";
import { placeMenu } from "./menuPlacement";

const view = { width: 800, height: 600 };
const menu = { width: 220, height: 34 };

describe("placeMenu", () => {
  it("sits just above the start of the selection", () => {
    expect(placeMenu({ top: 200, left: 100, height: 20 }, { top: 260, left: 300, height: 20 }, view, menu)).toEqual({ top: 160, left: 100 });
  });

  it("drops below the end when there is no room above", () => {
    expect(placeMenu({ top: 10, left: 100, height: 20 }, { top: 50, left: 300, height: 20 }, view, menu)).toEqual({ top: 76, left: 100 });
  });

  it("stays inside the editor sideways", () => {
    expect(placeMenu({ top: 300, left: 780, height: 20 }, null, view, menu)?.left).toBe(800 - 220 - 8);
    expect(placeMenu({ top: 300, left: 2, height: 20 }, null, view, menu)?.left).toBe(8);
  });

  it("uses the end when the start has scrolled out of view, and nothing when both have", () => {
    expect(placeMenu(null, { top: 300, left: 100, height: 20 }, view, menu)).toEqual({ top: 326, left: 100 });
    expect(placeMenu(null, null, view, menu)).toBeNull();
  });

  it("floats inside a selection that fills the view", () => {
    expect(placeMenu({ top: -200, left: 100, height: 20 }, { top: 590, left: 100, height: 20 }, view, menu)).toEqual({ top: 8, left: 100 });
  });
});

describe("SelectionMenu", () => {
  const render = (comment: boolean) =>
    renderToStaticMarkup(<SelectionMenu text="x" onAsk={() => {}} onComment={comment ? () => {} : undefined} onDone={() => {}} />);

  it("offers to ask, comment and copy, named in words", () => {
    const html = render(true);
    expect(html).toContain('role="toolbar"');
    expect(html).toContain("Ask");
    expect(html).toContain("Comment");
    expect(html).toContain("Copy");
  });

  it("leaves Comment out where a comment cannot be attached", () => {
    expect(render(false)).not.toContain("Comment");
  });
});
