import type { SpaceId } from "./spaces";

export type ShortcutAction =
  | { type: "space"; delta: -1 | 1 }
  | { type: "btw" }
  | { type: "artifacts" }
  | { type: "terminal" }
  | { type: "version" }
  | { type: "item"; delta: -1 | 1 }
  | { type: "comment" }
  | { type: "legend" };

export type ShortcutContext = {
  space: SpaceId;
  /** A dialog, palette or drawer is open and owns the keyboard. */
  overlay: boolean;
};

/** The subset of a keyboard event the resolver reads, so it is testable without a DOM. */
export type KeyLike = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  target: EventTarget | null;
};

const TEXT_SELECTOR =
  "input, textarea, select, [contenteditable=''], [contenteditable='true'], " +
  "[role='textbox'], [role='combobox'], [role='searchbox'], .monaco-editor, .xterm";

const ACTIVATING_SELECTOR =
  "button, a[href], summary, [role='button'], [role='tab'], [role='option'], [role='switch']," +
  "[role='checkbox'], [role='menuitem'], [role='radio']";

function matches(target: EventTarget | null, selector: string): boolean {
  return typeof Element !== "undefined" && target instanceof Element && target.closest(selector) !== null;
}

/** Text entry: typed letters belong to the field, never to a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  // A read-only editor takes no text, so its keys stay available to the shortcuts.
  if (matches(target, "[data-editor-readonly='true']")) {
    return false;
  }
  if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }
  return matches(target, TEXT_SELECTOR);
}

/** Maps a key press to an action, or `null` when the key must be left alone. */
export function resolveShortcut(event: KeyLike, context: ShortcutContext): ShortcutAction | null {
  // Never during IME composition: those keys pick candidates.
  if (event.isComposing || event.key === "Process" || event.key === "Dead") {
    return null;
  }
  const mod = event.ctrlKey || event.metaKey;
  const typing = isTypingTarget(event.target);
  const inEditor = matches(event.target, ".monaco-editor") && !matches(event.target, "[data-editor-readonly='true']");
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  // The terminal toggles from anywhere, even from inside a field or the terminal itself.
  if (mod && !event.altKey && !event.shiftKey && (key === "j" || key === "`")) {
    return { type: "terminal" };
  }
  if (context.overlay) {
    return null;
  }
  // Monaco owns Cmd+K as the start of its chords; the editor wires BTW itself.
  if (mod && !event.altKey && key === "k" && !inEditor) {
    return { type: "btw" };
  }
  if (typing || mod || event.altKey) {
    return null;
  }
  if (event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    return { type: "space", delta: event.key === "ArrowLeft" ? -1 : 1 };
  }
  if (event.shiftKey && key === "a") {
    return { type: "artifacts" };
  }
  if (event.key === "?") {
    return { type: "legend" };
  }
  if (event.shiftKey) {
    return null;
  }
  // Space activates a focused button or tab; only a free Space opens BTW.
  if (event.key === " ") {
    return event.repeat || matches(event.target, ACTIVATING_SELECTOR) ? null : { type: "btw" };
  }
  const reviewing = context.space === "code" || context.space === "decisions";
  if (!reviewing || event.repeat) {
    return null;
  }
  if (key === "j") {
    return { type: "item", delta: 1 };
  }
  if (key === "k") {
    return { type: "item", delta: -1 };
  }
  if (key === "c") {
    return { type: "comment" };
  }
  if (key === "v" && context.space === "code") {
    return { type: "version" };
  }
  return null;
}

/** The shortcuts shown in the legend, in reading order. */
export const SHORTCUT_LEGEND: readonly { keys: string[]; label: string; scope: string }[] = [
  { keys: ["Shift", "←/→"], label: "Previous / next space", scope: "Everywhere" },
  { keys: ["Space"], label: "BTW: ask about what you are looking at", scope: "Everywhere" },
  { keys: ["Ctrl/⌘", "K"], label: "BTW, also while typing", scope: "Everywhere" },
  { keys: ["Shift", "A"], label: "Artifacts of this chat", scope: "Everywhere" },
  { keys: ["Ctrl/⌘", "J"], label: "Toggle the terminal", scope: "Everywhere" },
  { keys: ["Esc"], label: "Close the overlay or stop the running turn", scope: "Everywhere" },
  { keys: ["V"], label: "Switch between the current version (editable) and the previous one (read-only)", scope: "Code" },
  { keys: ["Ctrl/⌘", "Alt", "V"], label: "The same, with the cursor in the editor", scope: "Code" },
  { keys: ["Ctrl/⌘", "S"], label: "Save the open file (an * after its name means unsaved changes)", scope: "Code" },
  { keys: ["J", "K"], label: "Next / previous item in the queue", scope: "Code, Decisions" },
  { keys: ["C"], label: "Comment on the selection", scope: "Code, Decisions" },
  { keys: ["?"], label: "Show this legend", scope: "Everywhere" },
];
