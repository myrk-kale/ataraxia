import type { AgentChoice, MentionPath, SlashCommand } from "../lib/agent";

/**
 * The two pickers of the message field, the same for every agent:
 * - `/` runs an action, a command or a skill of the agent. It only counts at the very start of
 *   the message, which is the only place the agents run one.
 * - `@` points at something for the agent to look at: a file or folder of the repositories, or
 *   one of its agents. What goes into the message is plain text (`@src/main.rs`), which every
 *   agent reads with its own tools.
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
  kind: "command" | "file" | "dir" | "agent";
  /** The name shown. */
  label: string;
  /** A second line, muted: what it does or where it is. */
  detail: string;
  /** A hint on the right: arguments for a command, the repository for a path. */
  aside: string;
  /** What replaces the typed text. */
  insert: string;
  /** Keeps the picker open after choosing (a folder: go on typing inside it). */
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

export function commandItems(commands: SlashCommand[], query: string): PickerItem[] {
  return ranked(commands, (command) => score(command.name, query), MAX_SHOWN).map((command) => ({
    id: `command:${command.name}`,
    kind: "command",
    label: `/${command.name}`,
    detail: command.description,
    aside: command.hint ?? command.source ?? "",
    insert: `/${command.name} `,
    continues: false,
  }));
}

/** A path that has a space in it is quoted so the agent reads it as one. */
export function mentionText(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

function baseName(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function mentionItems(
  paths: MentionPath[],
  agents: AgentChoice[],
  query: string,
): PickerItem[] {
  const named = ranked(agents, (agent) => score(agent.id, query), MAX_SHOWN).map(
    (agent): PickerItem => ({
      id: `agent:${agent.id}`,
      kind: "agent",
      label: agent.id,
      detail: agent.description ?? "Agent",
      aside: "agent",
      insert: `@${agent.id} `,
      continues: false,
    }),
  );
  // A file is found by its name first, then by where it is; folders come before files that tie.
  const found = ranked(
    paths,
    (item) => {
      const byName = score(baseName(item.path), query);
      const byPath = score(item.path, query);
      if (byName === null && byPath === null) {
        return null;
      }
      return Math.max(byName === null ? -1 : byName + 50, byPath ?? -1) - (item.dir ? 0 : 1);
    },
    MAX_SHOWN,
  ).map(
    (item): PickerItem => ({
      id: `path:${item.path}`,
      kind: item.dir ? "dir" : "file",
      label: item.repository ? baseName(item.path) + (item.dir ? "/" : "") : item.path,
      detail: item.repository ? item.path : "",
      aside: item.repository ?? "",
      insert: item.dir ? mentionText(item.path) : `${mentionText(item.path)} `,
      continues: item.dir,
    }),
  );
  return [...named, ...found].slice(0, MAX_SHOWN);
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
