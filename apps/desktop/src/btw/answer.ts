import type { ChatItem } from "../lib/agent";

/** The assistant text after the last user message: what the investigation answered. */
export function lastAnswer(items: readonly ChatItem[]): string {
  let start = 0;
  items.forEach((item, index) => {
    if (item.kind === "message" && item.role === "user") {
      start = index + 1;
    }
  });
  return items
    .slice(start)
    .filter((item) => item.kind === "message" && item.role === "assistant")
    .map((item) => (item.kind === "message" ? item.text : ""))
    .join("\n\n")
    .trim();
}

/** `path:3-9` style label for the context chip. */
export function contextLabel(item: { label: string; path?: string; startLine?: number; endLine?: number } | null): string {
  if (!item) {
    return "No selection";
  }
  if (!item.path) {
    return item.label;
  }
  if (item.startLine && item.endLine && item.endLine !== item.startLine) {
    return `${item.path}:${item.startLine}-${item.endLine}`;
  }
  return item.startLine ? `${item.path}:${item.startLine}` : item.path;
}

const FENCE = "```ataraxia-actions";

/** The answer without the machine block BTW ends with when it was asked to do something. */
export function withoutActions(text: string): string {
  let out = text;
  // A block still streaming in has no closing fence yet: hide it as well.
  for (let start = out.lastIndexOf(FENCE); start >= 0; start = out.lastIndexOf(FENCE)) {
    const close = out.indexOf("```", start + FENCE.length);
    out = out.slice(0, start) + (close >= 0 ? out.slice(close + 3) : "");
  }
  return out.trim();
}

const DONE = "\n\nDone in Ataraxia:\n";

/** What BTW did in Ataraxia, one line each, from the summary the engine wrote. */
export function doneInAtaraxia(summary: string | null): string[] {
  const at = summary?.indexOf(DONE) ?? -1;
  if (!summary || at < 0) {
    return [];
  }
  return summary
    .slice(at + DONE.length)
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);
}
