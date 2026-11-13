// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { currentFocus, restoreFocus } from "./focus";

function add(tag: string, parent: HTMLElement = document.body): HTMLElement {
  const node = document.createElement(tag);
  node.tabIndex = 0;
  parent.appendChild(node);
  return node;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("terminal focus", () => {
  it("reads the focused element, and nothing when only the body has focus", () => {
    expect(currentFocus()).toBeNull();
    const input = add("input");
    input.focus();
    expect(currentFocus()).toBe(input);
  });

  it("returns focus to the element that had it before the panel opened", () => {
    const input = add("input");
    const panel = add("section");
    const inner = add("textarea", panel);
    input.focus();
    const previous = currentFocus();
    inner.focus();
    panel.remove();
    expect(document.activeElement).toBe(document.body);
    restoreFocus(previous);
    expect(document.activeElement).toBe(input);
  });

  it("does nothing when that element is gone", () => {
    const input = add("input");
    const panel = add("section");
    input.focus();
    const previous = currentFocus();
    input.remove();
    panel.remove();
    restoreFocus(previous);
    expect(document.activeElement).toBe(document.body);
  });

  it("does not take focus from something the user moved to outside the panel", () => {
    const input = add("input");
    const other = add("button");
    const panel = add("section");
    input.focus();
    const previous = currentFocus();
    other.focus();
    panel.remove();
    restoreFocus(previous);
    expect(document.activeElement).toBe(other);
  });

  it("has nothing to restore when focus was on the body", () => {
    restoreFocus(null);
    expect(document.activeElement).toBe(document.body);
  });
});
