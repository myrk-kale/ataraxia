import { Check, ChevronDown, ChevronRight, CircleAlert, Eye, File as FileIcon, Folder } from "lucide-react";
import { useMemo } from "react";
import type { ChangedFile, Level, ReviewMark, ReviewPriority, Unit } from "../lib/insights";
import { buildTree, CHANGE_LETTER, visibleRows } from "./model";

const LEVEL_LABEL: Record<Level, string> = { high: "High", medium: "Medium", low: "Low" };

/** Priority is a word first; the colour only reinforces it. */
const LEVEL_TONE: Record<Level, string> = {
  high: "text-cg-red",
  medium: "text-cg-amber-text",
  low: "text-cg-muted-strong",
};

// Added and deleted keep the diff colours; every other change is a plain letter.
const CHANGE_COLOR: Record<ChangedFile["change"], string> = {
  added: "text-cg-add-fg",
  modified: "text-cg-muted-strong",
  deleted: "text-cg-del-fg",
  renamed: "text-cg-muted-strong",
};

const CHANGE_NAME: Record<ChangedFile["change"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
};

const MARK_LABEL: Record<ReviewMark["state"], string> = {
  unreviewed: "",
  viewed: "viewed",
  approved: "approved",
  "changes-requested": "changes requested",
};

const ROW =
  "flex w-full items-center gap-2 rounded-cg-sm px-2 py-1.5 text-left text-small hover:bg-cg-tint aria-selected:bg-cg-tint aria-selected:text-cg-ink";

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function dirName(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

/** Where a file stands in the review. Each state has its own shape, so it reads without colour. */
function MarkGlyph({ state }: { state: ReviewMark["state"] | undefined }) {
  const value = state ?? "unreviewed";
  const label = MARK_LABEL[value];
  const common = { "aria-label": label || undefined, role: label ? "img" : undefined, size: 13 } as const;
  const slot = "flex w-3.5 flex-none items-center justify-center";
  if (value === "approved") {
    return (
      <span className={slot}>
        <Check {...common} className="text-cg-green" />
      </span>
    );
  }
  if (value === "changes-requested") {
    return (
      <span className={slot}>
        <CircleAlert {...common} className="text-cg-red" />
      </span>
    );
  }
  if (value === "viewed") {
    return (
      <span className={slot}>
        <Eye {...common} className="text-cg-muted" />
      </span>
    );
  }
  return <span aria-hidden="true" className={slot} />;
}

function Counts({ file }: { file: Pick<ChangedFile, "additions" | "deletions" | "binary"> }) {
  if (file.binary) {
    return <span className="flex-none text-small text-cg-muted">binary</span>;
  }
  return (
    <span className="flex flex-none gap-1 font-mono text-small">
      {file.additions > 0 ? <span className="text-cg-add-fg">+{file.additions}</span> : null}
      {file.deletions > 0 ? <span className="text-cg-del-fg">−{file.deletions}</span> : null}
    </span>
  );
}

function Letter({ change, name }: { change: ChangedFile["change"]; name: string }) {
  return (
    <span aria-label={name} className={`w-3 flex-none text-center font-mono text-small font-semibold ${CHANGE_COLOR[change]}`} role="img">
      {CHANGE_LETTER[change]}
    </span>
  );
}

/** The words for a unit's kind and change: the list says them plainly instead of with letters. */
const KIND_WORD: Record<string, string> = {
  function: "function",
  method: "method",
  class: "class",
  struct: "struct",
  enum: "enum",
  trait: "trait",
  interface: "interface",
  impl: "impl",
  module: "module",
  type: "type",
  const: "constant",
  scope: "top level",
  file: "file",
};

const CHANGE_WORD: Record<string, string> = { added: "new", modified: "changed", removed: "removed" };

type QueueRow = {
  key: string;
  name: string;
  detail: string;
  level: Level;
  score: number;
  mark: ReviewMark["state"] | undefined;
  signatureChanged: boolean;
  unit: Unit | null;
  path: string;
};

function withoutExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]+$/, "");
}

/**
 * Every component to review as one flat list, most critical first: the functions, classes and types
 * that changed, not the files they live in. A component the parser could not break down (a lock
 * file, a README) is a row of its own.
 */
function queueRows(priority: ReviewPriority, marks: ReadonlyMap<string, ReviewMark["state"]>): QueueRow[] {
  const units = new Map((priority.units ?? []).map((unit) => [unit.id, unit]));
  const seen = new Set<string>();
  const rows: QueueRow[] = [];
  for (const component of priority.components) {
    const members = (component.units ?? []).map((id) => units.get(id)).filter((unit): unit is Unit => Boolean(unit));
    if (members.length === 0) {
      for (const path of component.files) {
        if (!seen.has(path)) {
          seen.add(path);
          const file = priority.files.find((item) => item.path === path);
          rows.push({
            key: `file:${path}`,
            name: fileName(path),
            detail: "file",
            level: file?.level ?? component.level,
            score: file?.score ?? component.score,
            mark: marks.get(path),
            signatureChanged: false,
            unit: null,
            path,
          });
        }
      }
      continue;
    }
    for (const unit of members) {
      if (seen.has(unit.id)) {
        continue;
      }
      seen.add(unit.id);
      const topLevel = unit.kind === "scope";
      rows.push({
        key: unit.id,
        name: unit.kind === "file" ? fileName(unit.name) : topLevel ? `${withoutExtension(component.name)} top level` : unit.name,
        detail: [KIND_WORD[unit.kind] ?? unit.kind, CHANGE_WORD[unit.change] ?? unit.change].join(" · "),
        level: unit.level,
        score: unit.score,
        mark: marks.get(unit.path),
        signatureChanged: unit.signature_changed,
        unit,
        path: unit.path,
      });
    }
  }
  // Stable: components with equal scores keep the order the review gave them.
  return rows.map((row, index) => ({ row, index })).sort((x, y) => y.row.score - x.row.score || x.index - y.index).map((item) => item.row);
}

/**
 * Components, most critical first, as plain blocks: the name, what it is, and how much it needs
 * a look. Why it ranks where it does is said when it is opened, not here.
 */
export function ComponentQueue({
  priority,
  marks,
  activeUnit,
  openPath,
  onOpenUnit,
  onOpenFile,
}: {
  priority: ReviewPriority;
  marks: ReadonlyMap<string, ReviewMark["state"]>;
  activeUnit: string | null;
  /** The file open in the editor, for a row that is a file rather than a unit. */
  openPath?: string | null;
  onOpenUnit: (unit: Unit) => void;
  onOpenFile: (path: string) => void;
}) {
  const rows = useMemo(() => queueRows(priority, marks), [priority, marks]);
  return (
    <ul aria-label="Components to review" className="flex flex-col gap-0.5 px-2 pb-4">
      {rows.map((row) => {
        const active = row.unit ? activeUnit === row.unit.id : openPath === row.path && activeUnit === null;
        return (
          <li key={row.key}>
            <button
              aria-selected={active}
              className="flex w-full flex-col gap-0.5 rounded-cg-md px-3 py-2 text-left hover:bg-cg-tint aria-selected:bg-cg-tint aria-selected:shadow-[inset_0_0_0_1px_var(--cg-line-strong)]"
              type="button"
              onClick={() => (row.unit ? onOpenUnit(row.unit) : onOpenFile(row.path))}
            >
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-ui font-medium text-cg-ink">{row.name}</span>
                <span className={`flex-none text-small font-medium ${LEVEL_TONE[row.level]}`}>{LEVEL_LABEL[row.level]}</span>
              </span>
              <span className="flex items-center gap-1.5 text-small text-cg-muted-strong">
                <span className="min-w-0 truncate">
                  {row.detail}
                  {row.signatureChanged ? " · signature changed" : ""}
                </span>
                <span className="ml-auto flex-none">
                  <MarkGlyph state={row.mark} />
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** One changed file per line, vertically. */
export function ChangedList({
  files,
  marks,
  openPath,
  onOpen,
}: {
  files: readonly ChangedFile[];
  marks: ReadonlyMap<string, ReviewMark["state"]>;
  openPath: string | null;
  onOpen: (path: string) => void;
}) {
  return (
    <ul aria-label="Changed files" className="flex flex-col px-2 pb-4">
      {files.map((file) => (
        <li key={file.path}>
          <button
            aria-selected={openPath === file.path}
            className={ROW}
            title={file.path}
            type="button"
            onClick={() => onOpen(file.path)}
          >
            <Letter change={file.change} name={CHANGE_NAME[file.change]} />
            <span className="min-w-0 flex-1 truncate">
              {fileName(file.path)}
              <span className="ml-1.5 text-cg-muted">{dirName(file.path)}</span>
            </span>
            <MarkGlyph state={marks.get(file.path)} />
            <Counts file={file} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The project's folders and files, for reading and editing without diffs. */
export function ProjectTree({
  paths,
  open,
  openPath,
  changed,
  onToggle,
  onOpen,
}: {
  paths: readonly string[];
  open: ReadonlySet<string>;
  openPath: string | null;
  changed: ReadonlyMap<string, ChangedFile["change"]>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const tree = useMemo(() => buildTree(paths), [paths]);
  const rows = useMemo(() => visibleRows(tree, open), [tree, open]);
  return (
    <ul aria-label="Project files" className="flex flex-col px-2 pb-4" role="tree">
      {rows.map(({ node, depth }) => {
        const isDir = node.kind === "dir";
        const expanded = open.has(node.path);
        return (
          <li key={node.path} role="none">
            <button
              aria-expanded={isDir ? expanded : undefined}
              aria-selected={!isDir && openPath === node.path}
              className={ROW}
              role="treeitem"
              style={{ paddingLeft: 8 + depth * 14 }}
              title={node.path}
              type="button"
              onClick={() => (isDir ? onToggle(node.path) : onOpen(node.path))}
            >
              {isDir ? (
                expanded ? (
                  <ChevronDown aria-hidden="true" className="flex-none text-cg-muted" size={13} />
                ) : (
                  <ChevronRight aria-hidden="true" className="flex-none text-cg-muted" size={13} />
                )
              ) : (
                <span className="w-[13px] flex-none" />
              )}
              {isDir ? (
                <Folder aria-hidden="true" className="flex-none text-cg-muted" size={13} />
              ) : (
                <FileIcon aria-hidden="true" className="flex-none text-cg-muted" size={13} />
              )}
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {!isDir && changed.has(node.path) ? (
                <span
                  aria-label={CHANGE_NAME[changed.get(node.path)!]}
                  className={`font-mono text-small font-semibold ${CHANGE_COLOR[changed.get(node.path)!]}`}
                  role="img"
                >
                  {CHANGE_LETTER[changed.get(node.path)!]}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
