/** What a click on "Copy" puts on the clipboard for a piece of rendered markdown. */
export type Copyable = {
  text: string;
  /** Set for tables, so pasting into a document or a spreadsheet keeps the cells. */
  html?: string;
};

/** The language a fenced block was given (`language-ts` on its code element), lower-cased. */
export function languageOf(className: string | undefined): string | null {
  const found = /(?:^|\s)language-([^\s]+)/.exec(className ?? "");
  return found?.[1]?.toLowerCase() ?? null;
}

function cell(text: string | null): string {
  // A tab or a line break inside a cell would split it when pasted.
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Tab-separated rows: what a spreadsheet, a terminal or a text editor expects of a table. */
export function tableToTsv(table: HTMLTableElement): string {
  return Array.from(table.rows)
    .map((row) => Array.from(row.cells, (item) => cell(item.textContent)).join("\t"))
    .join("\n");
}

export function tableCopy(table: HTMLTableElement): Copyable {
  return { text: tableToTsv(table), html: table.outerHTML };
}

/** A fenced block's text: the closing newline the parser leaves is not part of the code. */
export function codeText(children: unknown): string {
  const text = typeof children === "string" ? children : Array.isArray(children) ? children.join("") : "";
  return text.replace(/\n$/, "");
}

/** Puts text, and HTML when there is some, on the clipboard. Rejects when the platform refuses. */
export async function writeClipboard(item: Copyable): Promise<void> {
  if (item.html && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([item.text], { type: "text/plain" }),
          "text/html": new Blob([item.html], { type: "text/html" }),
        }),
      ]);
      return;
    } catch {
      // Some webviews take plain text only; fall through to that.
    }
  }
  await navigator.clipboard.writeText(item.text);
}
