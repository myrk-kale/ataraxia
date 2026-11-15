/**
 * What the right-click menu offers. The webview's own menu (Reload, Inspect, Look Up…) is not
 * the app's, so the app answers the click itself: the editing actions where text is typed, Copy
 * where text is selected, and what a link, a picture or the terminal can be asked.
 */

/** One line of the menu. The predefined ones are done by the system on whatever has the focus. */
export type MenuEntry =
  | { type: "predefined"; item: "Undo" | "Redo" | "Cut" | "Copy" | "Paste" | "SelectAll" }
  | { type: "separator" }
  | { type: "action"; text: string; enabled?: boolean; run: () => void | Promise<void> };

/** What the entries need to do their work, so they can be tried without a window. */
export type MenuTools = {
  /** The text selected on the page (not inside a text field). */
  selection: string;
  copyText: (text: string) => Promise<void>;
  copyImage: (image: HTMLImageElement) => Promise<void>;
  openLink: (href: string) => void;
};

/** The text selected in a terminal, asked of the terminal that draws it. */
const terminals = new WeakMap<Element, () => string>();

/** A terminal says how to read its selection (it is drawn, so the page does not know it). */
export function registerTerminalSelection(host: Element, read: () => string): () => void {
  terminals.set(host, read);
  return () => terminals.delete(host);
}

const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "number", ""]);

/** The text field the click is in, when it can be typed in. */
function writableField(element: Element): HTMLElement | null {
  const field = element.closest<HTMLElement>("input, textarea, [contenteditable]");
  if (!field) {
    return null;
  }
  if (field instanceof HTMLInputElement) {
    return TEXT_INPUTS.has(field.type) && !field.readOnly && !field.disabled ? field : null;
  }
  if (field instanceof HTMLTextAreaElement) {
    return !field.readOnly && !field.disabled ? field : null;
  }
  // `isContentEditable` is not there everywhere; the attribute says the same.
  const attribute = field.getAttribute("contenteditable");
  return field.isContentEditable || ["", "true", "plaintext-only"].includes(attribute ?? "false")
    ? field
    : null;
}

const EDITING: MenuEntry[] = [
  { type: "predefined", item: "Undo" },
  { type: "predefined", item: "Redo" },
  { type: "separator" },
  { type: "predefined", item: "Cut" },
  { type: "predefined", item: "Copy" },
  { type: "predefined", item: "Paste" },
  { type: "separator" },
  { type: "predefined", item: "SelectAll" },
];

/** Joins groups of entries with a line between them, leaving out the empty ones. */
function grouped(groups: MenuEntry[][]): MenuEntry[] {
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [{ type: "separator" as const }, ...group]));
}

/**
 * The menu for a right-click on `target`. `null` leaves the click to whatever is there (the code
 * editor has a menu of its own); an empty list means there is nothing to offer, and nothing is
 * shown.
 */
export function menuFor(target: EventTarget | null, tools: MenuTools): MenuEntry[] | null {
  const element = target instanceof Element ? target : ((target as Node | null)?.parentElement ?? null);
  if (!element || element.closest(".monaco-editor")) {
    return null;
  }

  const terminal = element.closest(".xterm");
  if (terminal) {
    const host = terminal.parentElement;
    const read = (host && terminals.get(host)) || terminals.get(terminal);
    const selected = read?.() ?? "";
    return [
      {
        type: "action",
        text: "Copy",
        enabled: selected !== "",
        run: () => tools.copyText(selected),
      },
      { type: "predefined", item: "Paste" },
    ];
  }

  if (writableField(element)) {
    return EDITING;
  }

  const copy: MenuEntry[] =
    tools.selection.trim() !== "" ? [{ type: "predefined", item: "Copy" }] : [];

  const anchor = element.closest("a[href]");
  const href = anchor?.getAttribute("href") ?? "";
  const link: MenuEntry[] = /^https?:\/\//i.test(href)
    ? [
        { type: "action", text: "Open Link", run: () => tools.openLink(href) },
        { type: "action", text: "Copy Link Address", run: () => tools.copyText(href) },
      ]
    : [];

  const image = element.closest("img");
  const picture: MenuEntry[] = image
    ? [{ type: "action", text: "Copy Image", run: () => tools.copyImage(image) }]
    : [];

  return grouped([copy, link, picture]);
}
