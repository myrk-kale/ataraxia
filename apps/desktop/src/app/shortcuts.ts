import type { SpaceId } from "./spaces";

export type ShortcutAction =
  | { type: "space"; delta: -1 | 1 }
  | { type: "btw" }
  | { type: "artifacts" }
  | { type: "terminal" }
  | { type: "version" }
  | { type: "item"; delta: -1 | 1 }
  | { type: "comment" }
  | { type: "wrap" }
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
  /** Physical key, for chords whose letter changes with the layout (Alt+Z on a Mac). */
  code?: string;
};

const TEXT_SELECTOR =
  "input, textarea, select, [contenteditable=''], [contenteditable='true'], " +
  "[role='textbox'], [role='combobox'], [role='searchbox'], .monaco-editor, .xterm";

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
  // Line wrapping flips from anywhere in Code; inside the editor Monaco wires the same chord.
  if (event.altKey && !mod && !event.shiftKey && event.code === "KeyZ" && context.space === "code" && !typing) {
    return { type: "wrap" };
  }
  // Old and new version of the open file; a bare V would be typed into the code, so it is a chord.
  if (event.altKey && !mod && !event.shiftKey && event.code === "KeyV" && context.space === "code" && !typing) {
    return { type: "version" };
  }
  if (typing || mod || event.altKey) {
    return null;
  }
  // The spaces are a column of dots: up goes to the one above, down to the one below.
  if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    return { type: "space", delta: event.key === "ArrowUp" ? -1 : 1 };
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
  return null;
}

/** The shortcuts shown in the legend, in reading order. */
export const SHORTCUT_LEGEND: readonly { keys: string[]; label: string; scope: string }[] = [
  { keys: ["Shift", "↑/↓"], label: "Previous / next space", scope: "Everywhere" },
  { keys: ["Ctrl/⌘", "K"], label: "BTW: ask about what you have open, in any space", scope: "Everywhere" },
  { keys: ["Shift", "A"], label: "Artifacts of this chat", scope: "Everywhere" },
  { keys: ["Ctrl/⌘", "J"], label: "Toggle the terminal", scope: "Everywhere" },
  { keys: ["Esc"], label: "Close the overlay or stop the running turn", scope: "Everywhere" },
  { keys: ["Alt", "V"], label: "Switch between the current version (editable) and the previous one (read-only)", scope: "Code" },
  { keys: ["Alt", "Z"], label: "Wrap long lines or let them run on", scope: "Code" },
  { keys: ["Ctrl/⌘", "S"], label: "Save the open file (an * after its name means unsaved changes)", scope: "Code" },
  { keys: ["J", "K"], label: "Next / previous item in the queue", scope: "Code, Decisions" },
  { keys: ["C"], label: "Comment on the selection", scope: "Code, Decisions" },
  { keys: ["?"], label: "Show this legend", scope: "Everywhere" },
];
