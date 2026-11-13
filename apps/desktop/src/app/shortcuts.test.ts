// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { resolveShortcut, type KeyLike, type ShortcutContext } from "./shortcuts";

const idle: ShortcutContext = { space: "chat", overlay: false };

function press(key: string, extra: Partial<KeyLike> = {}, target: EventTarget | null = document.body) {
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    target,
    ...extra,
  } satisfies KeyLike;
}

function el(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

describe("shortcuts", () => {
  it("navigates spaces with Shift+arrows", () => {
    expect(resolveShortcut(press("ArrowRight", { shiftKey: true }), idle)).toEqual({ type: "space", delta: 1 });
    expect(resolveShortcut(press("ArrowLeft", { shiftKey: true }), idle)).toEqual({ type: "space", delta: -1 });
  });

  it("opens BTW with a free Space or Ctrl/Cmd+K", () => {
    expect(resolveShortcut(press(" "), idle)).toEqual({ type: "btw" });
    expect(resolveShortcut(press("k", { ctrlKey: true }), idle)).toEqual({ type: "btw" });
    expect(resolveShortcut(press("k", { metaKey: true }), idle)).toEqual({ type: "btw" });
  });

  it("never captures keys typed into fields, editors or the terminal", () => {
    for (const markup of [
      "<input />",
      "<textarea></textarea>",
      "<div contenteditable='true'></div>",
      "<div class='monaco-editor'><span id='x' tabindex='0'></span></div>",
      "<div class='xterm'><span tabindex='0'></span></div>",
      "<div role='textbox' tabindex='0'></div>",
    ]) {
      const target = el(markup);
      const inner = (target.firstElementChild as HTMLElement | null) ?? target;
      for (const key of [" ", "j", "k", "c", "v", "?"]) {
        expect(resolveShortcut(press(key), { space: "code", overlay: false }) && true).toBeTruthy();
        expect(resolveShortcut(press(key, {}, inner), { space: "code", overlay: false }), `${markup} ${key}`).toBeNull();
      }
      expect(resolveShortcut(press("ArrowRight", { shiftKey: true }, inner), idle)).toBeNull();
      expect(resolveShortcut(press("A", { shiftKey: true }, inner), idle)).toBeNull();
    }
  });

  it("allows Ctrl+K in a text field but leaves it to Monaco inside the editor", () => {
    expect(resolveShortcut(press("k", { ctrlKey: true }, el("<input />")), idle)).toEqual({ type: "btw" });
    const editor = el("<div class='monaco-editor'><span tabindex='0'></span></div>");
    expect(resolveShortcut(press("k", { ctrlKey: true }, editor.firstElementChild), idle)).toBeNull();
  });

  it("does not steal Space from a focused button, tab or option", () => {
    for (const markup of ["<button></button>", "<div role='tab'></div>", "<div role='option'></div>", "<a href='#'></a>"]) {
      expect(resolveShortcut(press(" ", {}, el(markup)), idle), markup).toBeNull();
    }
  });

  it("ignores everything during IME composition", () => {
    expect(resolveShortcut(press("k", { ctrlKey: true, isComposing: true }), idle)).toBeNull();
    expect(resolveShortcut(press("Process"), idle)).toBeNull();
    expect(resolveShortcut(press(" ", { isComposing: true }), idle)).toBeNull();
  });

  it("scopes review keys to the spaces that have a queue", () => {
    const code: ShortcutContext = { space: "code", overlay: false };
    const decisions: ShortcutContext = { space: "decisions", overlay: false };
    expect(resolveShortcut(press("j"), code)).toEqual({ type: "item", delta: 1 });
    expect(resolveShortcut(press("k"), decisions)).toEqual({ type: "item", delta: -1 });
    expect(resolveShortcut(press("c"), decisions)).toEqual({ type: "comment" });
    expect(resolveShortcut(press("v"), code)).toEqual({ type: "version" });
    expect(resolveShortcut(press("v"), decisions)).toBeNull();
    for (const key of ["j", "k", "c", "v"]) {
      expect(resolveShortcut(press(key), idle)).toBeNull();
      expect(resolveShortcut(press(key), { space: "flow", overlay: false })).toBeNull();
    }
  });

  it("opens the artifacts drawer and the legend", () => {
    expect(resolveShortcut(press("A", { shiftKey: true }), idle)).toEqual({ type: "artifacts" });
    expect(resolveShortcut(press("?", { shiftKey: true }), idle)).toEqual({ type: "legend" });
  });

  it("toggles the terminal from anywhere, even while typing", () => {
    expect(resolveShortcut(press("j", { ctrlKey: true }), idle)).toEqual({ type: "terminal" });
    expect(resolveShortcut(press("`", { metaKey: true }, el("<input />")), idle)).toEqual({ type: "terminal" });
    expect(resolveShortcut(press("j", { ctrlKey: true }), { space: "chat", overlay: true })).toEqual({ type: "terminal" });
  });

  it("leaves the keyboard to an open overlay", () => {
    const open: ShortcutContext = { space: "code", overlay: true };
    for (const event of [press(" "), press("j"), press("ArrowRight", { shiftKey: true }), press("k", { ctrlKey: true })]) {
      expect(resolveShortcut(event, open)).toBeNull();
    }
  });

  it("ignores key repeat for toggles and modified combinations it does not own", () => {
    expect(resolveShortcut(press(" ", { repeat: true }), idle)).toBeNull();
    expect(resolveShortcut(press("j", { repeat: true }), { space: "code", overlay: false })).toBeNull();
    expect(resolveShortcut(press("c", { ctrlKey: true }), { space: "code", overlay: false })).toBeNull();
    expect(resolveShortcut(press("c", { altKey: true }), { space: "code", overlay: false })).toBeNull();
  });
});
