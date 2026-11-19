import type { SpaceId } from "./spaces";

export type ShortcutAction =
  | { type: "space"; delta: -1 | 1 }
  | { type: "previous-workspace" }
  | { type: "btw"; private: boolean }
  | { type: "tasks" }
  | { type: "memory" }
  | { type: "search" }
  | { type: "branch" }
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

/**
 * Control with a backtick, no Alt, Shift or Cmd: the terminal toggle. Control on every platform,
 * the Mac included, as in the editors people know it from. It matches the physical key as well as
 * the character: with Control held, a Mac reports the backtick as a dead key (or as the layout's
 * own character, the apostrophe on a Brazilian keyboard) while the key stays `Backquote`.
 */
export function isTerminalToggle(
  event: Pick<KeyLike, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing"> & { code?: string },
): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing &&
    (event.key === "`" || event.code === "Backquote")
  );
}

export function isSearchKey(event: KeyLike): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.repeat &&
    !event.isComposing && event.key.toLowerCase() === "b";
}

/** Shift with an up or down arrow, and nothing else held: the move between spaces. */
export function isSpaceKey(event: Pick<KeyLike, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  return (
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === "ArrowUp" || event.key === "ArrowDown")
  );
}

/** Maps a key press to an action, or `null` when the key must be left alone. */
export function resolveShortcut(event: KeyLike, context: ShortcutContext): ShortcutAction | null {
  // The terminal toggles from anywhere, even from inside a field or the terminal itself. Before
  // the guard below: Control and the backtick can arrive as a dead key.
  if (isTerminalToggle(event)) {
    return { type: "terminal" };
  }
  // Never during IME composition: those keys pick candidates.
  if (event.isComposing || event.key === "Process" || event.key === "Dead") {
    return null;
  }
  const mod = event.ctrlKey || event.metaKey;
  const typing = isTypingTarget(event.target);
  const inEditor = matches(event.target, ".monaco-editor") && !matches(event.target, "[data-editor-readonly='true']");
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  if (context.overlay) {
    return null;
  }
  if (isSearchKey(event)) {
    return { type: "search" };
  }
  // Monaco owns Cmd+K as the start of its chords; the editor wires BTW itself. With Shift it is
  // a private BTW, whose replies never reach the main chat.
  if (mod && !event.altKey && key === "k" && !inEditor) {
    return { type: "btw", private: event.shiftKey };
  }
  // The tasks panel, from anywhere but the editor. Control+T stays the shell's inside the terminal.
  const inTerminal = matches(event.target, ".xterm");
  if (mod && !event.altKey && !event.shiftKey && key === "t" && !inEditor && !(inTerminal && event.ctrlKey) && !event.repeat) {
    return { type: "tasks" };
  }
  // The graph of what the agents remember: Ctrl/Cmd+Shift+G, not inside the editor (Monaco's find-previous).
  if (mod && event.shiftKey && !event.altKey && key === "g" && !inEditor && !event.repeat) {
    return { type: "memory" };
  }
  // Go to a branch from a link or a name, from anywhere (not inside the editor, where Monaco has its own).
  if (mod && event.shiftKey && !event.altKey && key === "b" && !inEditor && !event.repeat) {
    return { type: "branch" };
  }
  if (event.altKey && !mod && !event.shiftKey && event.code === "KeyW" && !typing && !event.repeat) {
    return { type: "previous-workspace" };
  }
  // Line wrapping flips from anywhere in Code; inside the editor Monaco wires the same chord.
  if (event.altKey && !mod && !event.shiftKey && event.code === "KeyZ" && context.space === "code" && !typing) {
    return { type: "wrap" };
  }
  // Old and new version of the open file; a bare V would be typed into the code, so it is a chord.
  if (event.altKey && !mod && !event.shiftKey && event.code === "KeyV" && context.space === "code" && !typing) {
    return { type: "version" };
  }
  // The spaces are a column of dots: up goes to the one above, down to the one below. It wins over
  // whatever has focus, a field, the editor or the terminal included, so the keyboard can always
  // leave where it is.
  if (isSpaceKey(event)) {
    return { type: "space", delta: event.key === "ArrowUp" ? -1 : 1 };
  }
  if (typing || mod || event.altKey) {
    return null;
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
  const reviewing = context.space === "code";
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
  { keys: ["Alt", "W"], label: "Switch to the previous workspace", scope: "Everywhere" },
  { keys: ["Shift", "↑/↓"], label: "Previous / next space, even while typing or in the editor and terminal", scope: "Everywhere" },
  { keys: ["Ctrl/⌘", "K"], label: "BTW: ask about what you have open, in any space", scope: "Everywhere" },
  { keys: ["Ctrl/⌘", "Shift", "K"], label: "Private BTW: nothing of it is sent to the main chat", scope: "Everywhere" },
  { keys: ["Ctrl/⌘", "T"], label: "Tasks panel", scope: "Everywhere" },
  { keys: ["Ctrl/⌘", "Shift", "G"], label: "Memory graph: what the agents remember", scope: "Everywhere" },
  { keys: ["Ctrl/⌘", "B"], label: "Global search", scope: "Everywhere" },
  { keys: ["Ctrl/⌘", "Shift", "B"], label: "Go to a branch by name or URL", scope: "Everywhere" },
  { keys: ["Shift", "A"], label: "Artifacts of this chat", scope: "Everywhere" },
  { keys: ["Ctrl", "`"], label: "Toggle the terminal (Control, on the Mac too)", scope: "Everywhere" },
  { keys: ["Esc"], label: "Close the overlay or stop the running turn", scope: "Everywhere" },
  { keys: ["Enter"], label: "Send the message, or add it to the queue while the agent works", scope: "Message field" },
  { keys: ["Ctrl/⌘", "Shift", "M"], label: "Dictate: speak, and it is written into the message field on this computer", scope: "Chat" },
  { keys: ["Ctrl/⌘", "Enter"], label: "Send it now: stop the agent and put the message first instead of queueing it", scope: "Message field" },
  { keys: ["Alt", "V"], label: "Switch between the current version (editable) and the previous one (read-only)", scope: "Code" },
  { keys: ["Alt", "Z"], label: "Wrap long lines or let them run on", scope: "Code" },
  { keys: ["Ctrl/⌘", "S"], label: "Save the open file (an * after its name means unsaved changes)", scope: "Code" },
  { keys: ["J", "K"], label: "Next / previous item in the queue", scope: "Code" },
  { keys: ["C"], label: "Comment on the selection", scope: "Code" },
  { keys: ["?"], label: "Show this legend", scope: "Everywhere" },
];
