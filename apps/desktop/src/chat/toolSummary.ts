const SUMMARY_KEYS = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "filepath",
  "path",
  "pattern",
  "query",
  "url",
  "description",
] as const;

const MAX_SUMMARY = 90;

export type ToolInput =
  | { kind: "empty" }
  | { kind: "fields"; fields: [string, unknown][] }
  | { kind: "text"; text: string };

export function parseToolInput(input: string): ToolInput {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { kind: "empty" };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { kind: "fields", fields: Object.entries(parsed) };
    }
  } catch {
    // Plain text input (for example a shell command).
  }
  return { kind: "text", text: trimmed };
}

function clip(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.length > MAX_SUMMARY
    ? `${firstLine.slice(0, MAX_SUMMARY - 1)}…`
    : firstLine;
}

/** One line describing what a tool call is doing, shown while the card is collapsed. */
export function toolSummary(input: string): string {
  const parsed = parseToolInput(input);
  if (parsed.kind === "empty") {
    return "";
  }
  if (parsed.kind === "text") {
    return clip(parsed.text);
  }
  for (const key of SUMMARY_KEYS) {
    const entry = parsed.fields.find(([name]) => name === key);
    if (entry && typeof entry[1] === "string" && entry[1].length > 0) {
      return clip(entry[1]);
    }
  }
  return "";
}

export type DiffLine = { kind: "add" | "remove" | "context"; text: string };

/** Lines of a unified diff, or of an old/new string pair, for colored rendering. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const text of oldText.split("\n")) {
    lines.push({ kind: "remove", text });
  }
  for (const text of newText.split("\n")) {
    lines.push({ kind: "add", text });
  }
  return lines;
}

export function unifiedDiffLines(diff: string): DiffLine[] {
  return diff.split("\n").map((text) => {
    if (text.startsWith("+") && !text.startsWith("+++")) {
      return { kind: "add", text };
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      return { kind: "remove", text };
    }
    return { kind: "context", text };
  });
}
