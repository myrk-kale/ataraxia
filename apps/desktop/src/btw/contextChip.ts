import type { BtwContextItem } from "../lib/insights";

/** The lines a context item covers, as `a.py:12-20`, `a.py:12` or just the path. */
function place(item: BtwContextItem): string {
  const path = item.path ?? "";
  if (!path) {
    return "";
  }
  const { startLine, endLine } = item;
  if (startLine && endLine && endLine !== startLine) {
    return `${path}:${startLine}-${endLine}`;
  }
  return startLine ? `${path}:${startLine}` : path;
}

/**
 * What the question is about, in a few words for the person asking it: the same thing the agent is
 * told, so there is no guessing what "this" means.
 */
export function contextChip(item: BtwContextItem | null): string | null {
  if (!item) {
    return null;
  }
  if (item.kind === "selection") {
    const lines = item.text ? item.text.split("\n").length : 0;
    const size = lines > 0 ? ` · ${lines} ${lines === 1 ? "line" : "lines"}` : "";
    return `Selection · ${place(item)}${size}`;
  }
  if (item.kind === "file") {
    return `File · ${place(item)}`;
  }
  return item.label;
}
