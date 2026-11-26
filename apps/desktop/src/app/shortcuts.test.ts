// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isTerminalToggle, resolveShortcut, SHORTCUT_LEGEND, type KeyLike, type ShortcutContext } from "./shortcuts";

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
  it("switches workspaces with Alt+W outside text entry and overlays", () => {
    const key = press("w", { altKey: true, code: "KeyW" });
    expect(resolveShortcut(key, idle)).toEqual({ type: "previous-workspace" });
    expect(resolveShortcut(key, { ...idle, overlay: true })).toBeNull();
    expect(resolveShortcut(press("w", { altKey: true, code: "KeyW" }, el("<textarea></textarea>")), idle)).toBeNull();
    expect(resolveShortcut(press("w", { altKey: true, code: "KeyW", repeat: true }), idle)).toBeNull();
  });
  it("navigates spaces with Shift+Up and Shift+Down", () => {
    expect(resolveShortcut(press("ArrowDown", { shiftKey: true }), idle)).toEqual({ type: "space", delta: 1 });
    expect(resolveShortcut(press("ArrowUp", { shiftKey: true }), idle)).toEqual({ type: "space", delta: -1 });
    expect(resolveShortcut(press("ArrowRight", { shiftKey: true }), idle)).toBeNull();
  });

  it("opens BTW with Ctrl/Cmd+K only, never with Space", () => {
    expect(resolveShortcut(press(" "), idle)).toBeNull();
    expect(resolveShortcut(press("k", { ctrlKey: true }), idle)).toEqual({ type: "btw", private: false });
    expect(resolveShortcut(press("k", { metaKey: true }), idle)).toEqual({ type: "btw", private: false });
  });

  it("opens a private BTW with Ctrl/Cmd+Shift+K", () => {
    expect(resolveShortcut(press("K", { metaKey: true, shiftKey: true }), idle)).toEqual({ type: "btw", private: true });
    expect(resolveShortcut(press("k", { ctrlKey: true, shiftKey: true }, el("<input />")), idle)).toEqual({
      type: "btw",
      private: true,
    });
  });

  it("opens the browser with Ctrl/Cmd+Shift+L, except inside the editor and with a dialog open", () => {
    expect(resolveShortcut(press("l", { metaKey: true, shiftKey: true }), idle)).toEqual({ type: "browser" });
    expect(resolveShortcut(press("L", { ctrlKey: true, shiftKey: true }, el("<input>")), idle)).toEqual({ type: "browser" });
    expect(resolveShortcut(press("l", { metaKey: true }), idle)).toBeNull();
    expect(resolveShortcut(press("l", { metaKey: true, shiftKey: true }), { ...idle, overlay: true })).toBeNull();
    const editor = el('<div class="monaco-editor"><textarea></textarea></div>');
    expect(resolveShortcut(press("l", { metaKey: true, shiftKey: true }, editor.firstElementChild), idle)).toBeNull();
  });

  it("opens the memory graph with Ctrl/Cmd+Shift+G, except inside the editor and with a dialog open", () => {
    expect(resolveShortcut(press("g", { metaKey: true, shiftKey: true }), idle)).toEqual({ type: "memory" });
    expect(resolveShortcut(press("G", { ctrlKey: true, shiftKey: true }, el("<textarea></textarea>")), idle)).toEqual({ type: "memory" });
    expect(resolveShortcut(press("g", { metaKey: true }), idle)).toBeNull();
    expect(resolveShortcut(press("g", { metaKey: true, shiftKey: true }), { ...idle, overlay: true })).toBeNull();
    const editor = el('<div class="monaco-editor"><textarea></textarea></div>');
    expect(resolveShortcut(press("g", { metaKey: true, shiftKey: true }, editor.firstElementChild), idle)).toBeNull();
  });

  it("opens the tasks panel with Ctrl/Cmd+T, leaving Control+T to the shell in the terminal", () => {
    expect(resolveShortcut(press("t", { metaKey: true }), idle)).toEqual({ type: "tasks" });
    expect(resolveShortcut(press("t", { ctrlKey: true }, el("<textarea></textarea>")), idle)).toEqual({ type: "tasks" });
    const terminal = el("<div class='xterm'><span tabindex='0'></span></div>");
    expect(resolveShortcut(press("t", { ctrlKey: true }, terminal.firstElementChild), idle)).toBeNull();
    expect(resolveShortcut(press("t", { metaKey: true }, terminal.firstElementChild), idle)).toEqual({ type: "tasks" });
    const editor = el("<div class='monaco-editor'><span tabindex='0'></span></div>");
    expect(resolveShortcut(press("t", { metaKey: true }, editor.firstElementChild), idle)).toBeNull();
    expect(resolveShortcut(press("t", { metaKey: true }), { ...idle, overlay: true })).toBeNull();
  });

  it("goes to a branch with Ctrl/Cmd+Shift+B, even from a field, but not from the editor or an overlay", () => {
    expect(resolveShortcut(press("B", { ctrlKey: true, shiftKey: true }), idle)).toEqual({ type: "branch" });
    expect(resolveShortcut(press("b", { metaKey: true, shiftKey: true }, el("<textarea></textarea>")), idle)).toEqual({
      type: "branch",
    });
    expect(resolveShortcut(press("B", { ctrlKey: true, shiftKey: true }), { ...idle, overlay: true })).toBeNull();
    const editor = el("<div class='monaco-editor'><span tabindex='0'></span></div>");
    expect(resolveShortcut(press("B", { ctrlKey: true, shiftKey: true }, editor.firstElementChild), idle)).toBeNull();
  });

  it("opens global search with Ctrl/Cmd+B, including in the editor and terminal", () => {
    const editor = el("<div class='monaco-editor'><textarea></textarea></div>");
    const terminal = el("<div class='xterm'><textarea></textarea></div>");
    expect(resolveShortcut(press("b", { metaKey: true }, editor.firstElementChild), idle)).toEqual({ type: "search" });
    expect(resolveShortcut(press("b", { ctrlKey: true }, terminal.firstElementChild), idle)).toEqual({ type: "search" });
    expect(resolveShortcut(press("b", { ctrlKey: true }), { ...idle, overlay: true })).toBeNull();
    expect(resolveShortcut(press("b", { ctrlKey: true, isComposing: true }), idle)).toBeNull();
    expect(resolveShortcut(press("b"), idle)).toBeNull();
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
      for (const key of ["j", "k", "c", "?"]) {
        expect(resolveShortcut(press(key), { space: "code", overlay: false }) && true).toBeTruthy();
        expect(resolveShortcut(press(key, {}, inner), { space: "code", overlay: false }), `${markup} ${key}`).toBeNull();
      }
      expect(resolveShortcut(press("A", { shiftKey: true }, inner), idle)).toBeNull();
    }
  });

  it("moves between spaces with Shift+Up and Shift+Down from anywhere, fields, editor and terminal included", () => {
    for (const markup of [
      "<input />",
      "<textarea></textarea>",
      "<div contenteditable='true'></div>",
      "<div class='monaco-editor'><span tabindex='0'></span></div>",
      "<div class='xterm'><span tabindex='0'></span></div>",
      "<div role='combobox' tabindex='0'></div>",
      "<button></button>",
    ]) {
      const target = el(markup);
      const inner = (target.firstElementChild as HTMLElement | null) ?? target;
      expect(resolveShortcut(press("ArrowDown", { shiftKey: true }, inner), idle), markup).toEqual({ type: "space", delta: 1 });
      expect(resolveShortcut(press("ArrowUp", { shiftKey: true }, inner), idle), markup).toEqual({ type: "space", delta: -1 });
    }
    // With another modifier held it is a different chord (extend selection by word, for one).
    const field = el("<textarea></textarea>");
    expect(resolveShortcut(press("ArrowDown", { shiftKey: true, altKey: true }, field), idle)).toBeNull();
    expect(resolveShortcut(press("ArrowDown", { shiftKey: true, metaKey: true }, field), idle)).toBeNull();
    // Not while composing with an IME.
    expect(resolveShortcut(press("ArrowDown", { shiftKey: true, isComposing: true }, field), idle)).toBeNull();
  });

  it("allows Ctrl+K in a text field but leaves it to Monaco inside the editor", () => {
    expect(resolveShortcut(press("k", { ctrlKey: true }, el("<input />")), idle)).toEqual({ type: "btw", private: false });
    const editor = el("<div class='monaco-editor'><span tabindex='0'></span></div>");
    expect(resolveShortcut(press("k", { ctrlKey: true }, editor.firstElementChild), idle)).toBeNull();
  });

  it("leaves Space to the focused button, tab or option, and to the page", () => {
    for (const markup of ["<button></button>", "<div role='tab'></div>", "<div role='option'></div>", "<a href='#'></a>"]) {
      expect(resolveShortcut(press(" ", {}, el(markup)), idle), markup).toBeNull();
    }
  });

  it("switches between the old and new version with Alt+V in Code only, never with a bare V, and not from a field", () => {
    const code: ShortcutContext = { space: "code", overlay: false };
    // On a Mac Alt+V types a symbol, so the physical key is what counts.
    expect(resolveShortcut(press("√", { altKey: true, code: "KeyV" }), code)).toEqual({ type: "version" });
    expect(resolveShortcut(press("√", { altKey: true, code: "KeyV" }), { space: "chat", overlay: false })).toBeNull();
    expect(resolveShortcut(press("√", { altKey: true, code: "KeyV" }, el("<input />")), code)).toBeNull();
    expect(resolveShortcut(press("v", { code: "KeyV" }), code)).toBeNull();
    expect(resolveShortcut(press("v", { altKey: true, ctrlKey: true, code: "KeyV" }), code)).toBeNull();
  });

  it("switches between the old and new version with Alt+V in Code only, never with a bare V, and not from a field", () => {
    const code: ShortcutContext = { space: "code", overlay: false };
    // On a Mac Alt+V types a symbol, so the physical key is what counts.
    expect(resolveShortcut(press("√", { altKey: true, code: "KeyV" }), code)).toEqual({ type: "version" });
    expect(resolveShortcut(press("√", { altKey: true, code: "KeyV" }), { space: "chat", overlay: false })).toBeNull();
    expect(resolveShortcut(press("√", { altKey: true, code: "KeyV" }, el("<input />")), code)).toBeNull();
    expect(resolveShortcut(press("v", { code: "KeyV" }), code)).toBeNull();
    expect(resolveShortcut(press("v", { altKey: true, ctrlKey: true, code: "KeyV" }), code)).toBeNull();
  });

  it("flips line wrapping with Alt+Z in Code only, and not from a field", () => {
    const code = { space: "code", overlay: false } as const;
    expect(resolveShortcut(press("Ω", { altKey: true, code: "KeyZ" }), code)).toEqual({ type: "wrap" });
    expect(resolveShortcut(press("Ω", { altKey: true, code: "KeyZ" }), { space: "chat", overlay: false })).toBeNull();
    expect(resolveShortcut(press("Ω", { altKey: true, code: "KeyZ" }, el("<input />")), code)).toBeNull();
    expect(resolveShortcut(press("z", { code: "KeyZ" }), code)).toBeNull();
  });

  it("ignores everything during IME composition", () => {
    expect(resolveShortcut(press("k", { ctrlKey: true, isComposing: true }), idle)).toBeNull();
    expect(resolveShortcut(press("Process"), idle)).toBeNull();
    expect(resolveShortcut(press(" ", { isComposing: true }), idle)).toBeNull();
  });

  it("scopes review keys to the space that has a queue", () => {
    const code: ShortcutContext = { space: "code", overlay: false };
    expect(resolveShortcut(press("j"), code)).toEqual({ type: "item", delta: 1 });
    expect(resolveShortcut(press("k"), code)).toEqual({ type: "item", delta: -1 });
    expect(resolveShortcut(press("c"), code)).toEqual({ type: "comment" });
    for (const key of ["j", "k", "c"]) {
      expect(resolveShortcut(press(key), idle)).toBeNull();
      expect(resolveShortcut(press(key), { space: "flow", overlay: false })).toBeNull();
    }
  });

  it("opens the artifacts drawer and the legend", () => {
    expect(resolveShortcut(press("A", { shiftKey: true }), idle)).toEqual({ type: "artifacts" });
    expect(resolveShortcut(press("?", { shiftKey: true }), idle)).toEqual({ type: "legend" });
  });

  it("toggles the terminal with Control+backtick from anywhere, even while typing, and never with Cmd", () => {
    expect(resolveShortcut(press("`", { ctrlKey: true }), idle)).toEqual({ type: "terminal" });
    expect(resolveShortcut(press("`", { ctrlKey: true }, el("<input />")), idle)).toEqual({ type: "terminal" });
    expect(resolveShortcut(press("`", { ctrlKey: true }, el("<div class='xterm'><span tabindex='0'></span></div>")), idle)).toEqual({
      type: "terminal",
    });
    expect(resolveShortcut(press("`", { metaKey: true }), idle)).toBeNull();
    expect(resolveShortcut(press("`", { metaKey: true, ctrlKey: true }), idle)).toBeNull();
    expect(resolveShortcut(press("`", { ctrlKey: true }), { space: "chat", overlay: true })).toEqual({ type: "terminal" });
  });

  it("toggles the terminal by the physical Backquote key when the layout reports another character", () => {
    expect(resolveShortcut(press("Dead", { ctrlKey: true, code: "Backquote" }), idle)).toEqual({ type: "terminal" });
    expect(resolveShortcut(press("'", { ctrlKey: true, code: "Backquote" }), idle)).toEqual({ type: "terminal" });
    expect(resolveShortcut(press("Dead", { metaKey: true, code: "Backquote" }), idle)).toBeNull();
    expect(resolveShortcut(press("Dead", { ctrlKey: true, code: "KeyA" }), idle)).toBeNull();
    expect(isTerminalToggle(press("`", { ctrlKey: true, isComposing: true }))).toBe(false);
  });

  it("no longer toggles the terminal with Ctrl/Cmd+J", () => {
    expect(resolveShortcut(press("j", { ctrlKey: true }), idle)).toBeNull();
    expect(resolveShortcut(press("j", { metaKey: true }), { space: "code", overlay: false })).toBeNull();
    expect(resolveShortcut(press("j", { ctrlKey: true }), { space: "chat", overlay: true })).toBeNull();
    expect(isTerminalToggle(press("j", { ctrlKey: true }))).toBe(false);
    expect(SHORTCUT_LEGEND.some((entry) => entry.keys.includes("Ctrl/⌘") && entry.keys.includes("J"))).toBe(false);
    expect(SHORTCUT_LEGEND.some((entry) => entry.keys.includes("`") && entry.label.includes("terminal"))).toBe(true);
  });

  it("needs a modifier for the terminal and ignores Shift and Alt", () => {
    expect(resolveShortcut(press("`"), idle)).toBeNull();
    expect(resolveShortcut(press("~", { metaKey: true, shiftKey: true }), idle)).toBeNull();
    expect(resolveShortcut(press("`", { ctrlKey: true, shiftKey: true }), idle)).toBeNull();
    expect(resolveShortcut(press("`", { ctrlKey: true, altKey: true }), idle)).toBeNull();
    expect(isTerminalToggle(press("`", { ctrlKey: true }))).toBe(true);
    expect(isTerminalToggle(press("`", { metaKey: true }))).toBe(false);
    expect(isTerminalToggle(press("`", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("leaves the keyboard to an open overlay", () => {
    const open: ShortcutContext = { space: "code", overlay: true };
    for (const event of [press(" "), press("j"), press("ArrowDown", { shiftKey: true }), press("k", { ctrlKey: true })]) {
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
