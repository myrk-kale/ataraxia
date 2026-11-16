import type { ComposerResource, MentionPath } from "../lib/agent";

/**
 * The two pickers of the message field:
 * - `/` offers commands, skills and MCP servers at the very start of the message.
 * - `@` points at a file in one of the repositories. What goes into the message is plain text,
 *   which every agent reads with its own tools.
 */
export type Trigger = {
  kind: "command" | "mention";
  /** The text typed after the `/` or `@`, up to the caret. */
  query: string;
  /** What gets replaced when a choice is made: `[start, end)`, the symbol included. */
  start: number;
  end: number;
};

export type PickerItem = {
  id: string;
  kind: ComposerResource["kind"] | "file";
  /** The name shown. */
  label: string;
  /** A second line, muted: what it does or where it is. */
  detail: string;
  /** A hint on the right: arguments for a command, the repository for a path. */
  aside: string;
  /** What replaces the typed text. */
  insert: string;
  /** Keeps the picker open after choosing. */
  continues: boolean;
};

export const MAX_SHOWN = 40;

/** What the caret is in the middle of, if it is a `/command` or an `@mention`. */
export function findTrigger(text: string, caret: number, commands: boolean): Trigger | null {
  const upto = text.slice(0, caret);
  if (commands && upto.startsWith("/") && !/\s/.test(upto)) {
    return { kind: "command", query: upto.slice(1), start: 0, end: caret };
  }
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) {
    start -= 1;
  }
  const word = text.slice(start, caret);
  if (word.startsWith("@")) {
    // A quoted path (one with spaces in it) is typed as @"…": the quote is not part of the search.
    const query = word.slice(1).replace(/^"/, "");
    return { kind: "mention", query, start, end: caret };
  }
  return null;
}

/** How well `query` matches `text`: higher is better, `null` is no match. */
export function score(text: string, query: string): number | null {
  if (query === "") {
    return 0;
  }
  if (/[*?]/.test(query)) {
    let pattern = "";
    for (let i = 0; i < query.length; i++) {
      const char = query[i];
      if (char === "*" && query[i + 1] === "*") {
        if (query[i + 2] === "/") {
          pattern += "(?:.*/)?";
          i += 2;
        } else {
          pattern += ".*";
          i++;
        }
      } else if (char === "*") {
        pattern += "[^/]*";
      } else if (char === "?") {
        pattern += "[^/]";
      } else {
        pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }
    return new RegExp(`^${pattern}$`).test(text) ? 1000 - text.length : null;
  }
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  if (hay.startsWith(needle)) {
    return 1000 - hay.length;
  }
  const word = new RegExp(`[/\\-_.: ]${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(hay);
  if (word) {
    return 800 - word.index;
  }
  const at = hay.indexOf(needle);
  if (at >= 0) {
    return 600 - at;
  }
  // Letters in order, anywhere: `cmp` finds `compact`.
  let from = 0;
  let spread = 0;
  for (const letter of needle) {
    const found = hay.indexOf(letter, from);
    if (found < 0) {
      return null;
    }
    spread += found - from;
    from = found + 1;
  }
  return 300 - Math.min(spread, 250);
}

function ranked<T>(items: T[], rate: (item: T) => number | null, limit: number): T[] {
  const scored: { item: T; value: number; index: number }[] = [];
  items.forEach((item, index) => {
    const value = rate(item);
    if (value !== null) {
      scored.push({ item, value, index });
    }
  });
  scored.sort((a, b) => b.value - a.value || a.index - b.index);
  return scored.slice(0, limit).map((entry) => entry.item);
}

export function commandItems(resources: ComposerResource[], query: string): PickerItem[] {
  return ranked(resources, (resource) => score(resource.name, query), MAX_SHOWN).map((resource) => ({
    id: `${resource.kind}:${resource.name}`,
    kind: resource.kind,
    label: `/${resource.name}`,
    detail: resource.description,
    aside: resource.hint ?? resource.source ?? "",
    insert:
      resource.kind === "command"
        ? `/${resource.name} `
        : resource.kind === "skill"
          ? `Use the ${resource.name} skill for this task: `
          : `Use the ${resource.name} MCP server for this task: `,
    continues: false,
  }));
}

/** A path that has a space in it is quoted so the agent reads it as one. */
export function mentionText(path: string): string {
  return /[\s"\\]/.test(path)
    ? `@"${path.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`
    : `@${path}`;
}

function baseName(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function mentionItems(
  paths: MentionPath[],
  query: string,
): PickerItem[] {
  // Search only files. Directories and provider agents do not have reference semantics in Ataraxia.
  const found = ranked(
    paths.filter((item) => !item.dir),
    (item) => {
      const byName = score(baseName(item.path), query);
      const byPath = score(item.path, query);
      if (byName === null && byPath === null) {
        return null;
      }
      return Math.max(byName === null ? -1 : byName + 50, byPath ?? -1) - 1;
    },
    MAX_SHOWN,
  ).map(
    (item): PickerItem => ({
      id: `path:${item.path}`,
      kind: "file",
      label: item.repository ? baseName(item.path) : item.path,
      detail: item.repository ? item.path : "",
      aside: item.repository ?? "",
      insert: `${mentionText(item.path)} `,
      continues: false,
    }),
  );
  return found;
}

function matchingGlobFiles(pattern: string, files: string[]): string[] {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  const matcher = new RegExp(`^${source}$`);
  return files.filter((path) => matcher.test(path));
}

/** Expands each @glob reference against the file list supplied by the active workspace. */
export function expandGlobMentions(text: string, paths: MentionPath[]): string {
  const files = paths.filter((item) => !item.dir).map((item) => item.path);
  return text.replace(
    /(^|\s)@(?:"((?:\\.|[^"])*)"|([^\s]+))/g,
    (reference, prefix: string, quoted: string | undefined, bare: string | undefined) => {
      const pattern = (quoted ?? bare ?? "").replace(/\\(["\\])/g, "$1");
      if (!/[*?]/.test(pattern)) {
        return reference;
      }
      let matches = matchingGlobFiles(pattern, files);
      let suffix = "";
      if (matches.length === 0 && bare !== undefined) {
        const punctuation = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}"]);
        let end = pattern.length;
        while (end > 0 && punctuation.has(pattern[end - 1])) {
          end -= 1;
          const candidate = pattern.slice(0, end);
          if (/[*?]/.test(candidate)) {
            matches = matchingGlobFiles(candidate, files);
            if (matches.length > 0) {
              suffix = pattern.slice(end);
              break;
            }
          }
        }
      }
      return matches.length > 0
        ? `${prefix}${matches.map(mentionText).join(" ")}${suffix}`
        : reference;
    },
  );
}

/** The message with the typed `/…` or `@…` replaced by what was chosen, and where the caret goes. */
export function applyChoice(
  text: string,
  trigger: Trigger,
  insert: string,
): { text: string; caret: number } {
  // A space is already there after the caret: do not add a second one.
  const after = text.slice(trigger.end);
  const chosen = insert.endsWith(" ") && /^\s/.test(after) ? insert.slice(0, -1) : insert;
  return { text: text.slice(0, trigger.start) + chosen + after, caret: trigger.start + chosen.length + (chosen === insert ? 0 : 1) };
}
