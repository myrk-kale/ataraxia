import type { ChangedFile, Checkpoint, FileScore, ReviewPriority, Unit } from "../lib/insights";

export type TreeNode = {
  name: string;
  path: string;
  kind: "dir" | "file";
  children: TreeNode[];
};

/** Builds a sorted directory tree (folders first) from a flat list of relative paths. */
export function buildTree(paths: readonly string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", kind: "dir", children: [] };
  for (const full of paths) {
    const parts = full.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      const last = index === parts.length - 1;
      let child = node.children.find((item) => item.name === part && item.kind === (last ? "file" : "dir"));
      if (!child) {
        child = { name: part, path, kind: last ? "file" : "dir", children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  return root.children;
}

/** Flattens the tree into the rows currently visible, given which folders are open. */
export function visibleRows(
  nodes: readonly TreeNode[],
  open: ReadonlySet<string>,
  depth = 0,
): { node: TreeNode; depth: number }[] {
  const rows: { node: TreeNode; depth: number }[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "dir" && open.has(node.path)) {
      rows.push(...visibleRows(node.children, open, depth + 1));
    }
  }
  return rows;
}

/** Folders on the way to a file, so opening a file can reveal it in the tree. */
export function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  sh: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  sql: "sql",
  xml: "xml",
  svg: "xml",
  dockerfile: "dockerfile",
};

export function languageFor(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") {
    return "dockerfile";
  }
  const extension = name.includes(".") ? name.split(".").pop()! : "";
  return LANGUAGES[extension] ?? "plaintext";
}

export type LineChanges = {
  /** 1-based line numbers of the newer text that are new or edited. */
  added: number[];
  /** 1-based line numbers of the older text that were removed or edited. */
  removed: number[];
};

const MAX_DIFF_CELLS = 4_000_000;

/** Line-level difference (longest common subsequence), used to mark changes in the gutter. */
export function lineChanges(older: string, newer: string): LineChanges {
  const a = older === "" ? [] : older.split("\n");
  const b = newer === "" ? [] : newer.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length * y.length > MAX_DIFF_CELLS) {
    // Too big to compare exactly: say everything between the shared ends changed.
    return {
      added: y.map((_, index) => start + index + 1),
      removed: x.map((_, index) => start + index + 1),
    };
  }
  const table: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) {
      table[i]![j] = x[i] === y[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const added: number[] = [];
  const removed: number[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      removed.push(start + i + 1);
      i += 1;
    } else {
      added.push(start + j + 1);
      j += 1;
    }
  }
  while (i < x.length) {
    removed.push(start + i + 1);
    i += 1;
  }
  while (j < y.length) {
    added.push(start + j + 1);
    j += 1;
  }
  return { added, removed };
}

/** The line of the other version that sits at the same place, so toggling keeps your spot. */
export function mapLine(older: string, newer: string, line: number, from: "older" | "newer"): number {
  const changes = lineChanges(older, newer);
  const skip = from === "newer" ? changes.added : changes.removed;
  const other = from === "newer" ? changes.removed : changes.added;
  const kept = line - skip.filter((item) => item < line).length;
  let mapped = kept;
  for (const item of [...other].sort((x, y) => x - y)) {
    if (item <= mapped) {
      mapped += 1;
    }
  }
  return Math.max(1, mapped);
}

/** Files in review order: best-scored component first, best file first within it. */
export function reviewQueue(priority: ReviewPriority | null): string[] {
  if (!priority) {
    return [];
  }
  const score = new Map(priority.files.map((file) => [file.path, file.score]));
  return priority.components.flatMap((component) =>
    [...component.files].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || a.localeCompare(b)),
  );
}

export function fileScore(priority: ReviewPriority | null, path: string): FileScore | undefined {
  return priority?.files.find((file) => file.path === path);
}

export const CHANGE_LETTER: Record<ChangedFile["change"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

export function stepIn<T>(items: readonly T[], current: T | null, delta: -1 | 1): T | null {
  if (items.length === 0) {
    return null;
  }
  const index = current === null ? -1 : items.indexOf(current);
  if (index === -1) {
    return delta === 1 ? items[0]! : items[items.length - 1]!;
  }
  return items[Math.min(items.length - 1, Math.max(0, index + delta))]!;
}

/** What a checkpoint is a diff of, in words: `turn #3`, `main … feature`, `HEAD … working tree`. */
export function describeTarget(checkpoint: Checkpoint): string {
  if (checkpoint.source === "turn") {
    return "Agent turn";
  }
  const base = checkpoint.base_label ?? checkpoint.base_rev.slice(0, 7);
  const head = checkpoint.head_label ?? (checkpoint.head_live === false ? checkpoint.head_rev.slice(0, 7) : "working tree");
  return checkpoint.source === "manual" && !checkpoint.base_label ? "Working changes" : `${base} \u2192 ${head}`;
}

/**
 * What the Code space is showing, in plain words: the current branch against the reference the
 * header picked, or, with none, what changed last.
 */
export function shownLabel(
  checkpoint: Pick<Checkpoint, "source"> | null,
  reference: string | null,
  branch: string | null,
): string {
  if (reference) {
    return `${branch ?? "Working tree"} against ${reference}`;
  }
  if (!checkpoint || checkpoint.source === "compare") {
    return "No comparison chosen";
  }
  return checkpoint.source === "turn" ? "Last agent turn" : "Edits since the last check";
}

/**
 * Why the Changed and Components lists are empty, and what to do about it. Nothing is compared
 * unless a reference was picked: without one, only what the agent changed in a turn can show.
 */
export function noDiffMessage(reference: string | null, problem: string | null, branch: string | null): string {
  if (reference) {
    return problem ? `Nothing to show against ${reference}: ${problem}` : `No differences against ${reference}.`;
  }
  if (problem) {
    return problem;
  }
  const after = "What the agent changes shows here after each of its turns.";
  return branch
    ? `No comparison chosen. Pick a branch or a commit in Compare with… (in the header) to see what ${branch} changes against it. ${after}`
    : `This worktree is not on a branch, so there is nothing to compare. Switch to a branch in the header, then pick what to compare it with in Compare with…. ${after}`;
}

/** The checkpoint a review follows when none is chosen: the latest that is not a comparison. */
export function latestOfTurns<T extends Pick<Checkpoint, "source">>(checkpoints: readonly T[]): T | null {
  return [...checkpoints].reverse().find((item) => item.source !== "compare") ?? null;
}

/** Two values that serialize alike: a reload that found nothing new keeps what is on screen. */
export function unchanged<T>(before: T, after: T): boolean {
  try {
    return before === after || JSON.stringify(before) === JSON.stringify(after);
  } catch {
    return false;
  }
}

/** Units in the order to review them: most critical first, then by position. */
export function unitQueue(priority: ReviewPriority | null): Unit[] {
  return [...(priority?.units ?? [])].sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.start_line - b.start_line,
  );
}

/** The first line to show for a unit: its start, or the top of the file for a whole-file unit. */
export function unitLine(unit: Pick<Unit, "start_line">): number {
  return Math.max(1, unit.start_line);
}

export const UNIT_KIND_LABEL: Record<string, string> = {
  function: "fn",
  method: "method",
  class: "class",
  struct: "struct",
  enum: "enum",
  trait: "trait",
  interface: "interface",
  impl: "impl",
  module: "mod",
  type: "type",
  const: "const",
  scope: "top level",
  file: "file",
};
