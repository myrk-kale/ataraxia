import { Check, ChevronDown, ChevronRight, CircleAlert, Eye, File as FileIcon, Folder } from "lucide-react";
import { useMemo, type ReactElement } from "react";
import type { ChangedFile, ComponentScore, Level, ReviewMark, ReviewPriority, Unit } from "../lib/insights";
import { Tip } from "../ui/Overlay";
import { buildTree, CHANGE_LETTER, UNIT_KIND_LABEL, visibleRows } from "./model";

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

const UNIT_CHANGE: Record<string, { letter: string; change: ChangedFile["change"] }> = {
  added: { letter: "A", change: "added" },
  modified: { letter: "M", change: "modified" },
  removed: { letter: "D", change: "deleted" },
};

/** Shows the reason in a tooltip that opens on keyboard focus as well as on hover. */
function Why({ text, children }: { text: string; children: ReactElement<{ "aria-describedby"?: string }> }) {
  return text ? <Tip label={text}>{children}</Tip> : children;
}

/**
 * Components, most critical first. A component is a class, an impl or a file (or a feature the
 * model grouped across files); its rows are the functions, methods and types that changed.
 */
export function ComponentQueue({
  priority,
  marks,
  activeUnit,
  onOpenUnit,
  onOpenFile,
}: {
  priority: ReviewPriority;
  marks: ReadonlyMap<string, ReviewMark["state"]>;
  activeUnit: string | null;
  onOpenUnit: (unit: Unit) => void;
  onOpenFile: (path: string) => void;
}) {
  const units = useMemo(() => new Map((priority.units ?? []).map((unit) => [unit.id, unit])), [priority]);
  const scores = useMemo(() => new Map(priority.files.map((file) => [file.path, file])), [priority]);
  return (
    <ul aria-label="Components to review" className="flex flex-col gap-3 px-2 pb-4">
      {priority.components.map((component: ComponentScore) => {
        const reasonsId = `why-${component.id.replace(/\W/g, "-")}`;
        const members = (component.units ?? []).map((id) => units.get(id)).filter((unit): unit is Unit => Boolean(unit));
        return (
          <li key={component.id}>
            <div className="flex items-center gap-2 px-2 pt-1 pb-0.5">
              <span className="min-w-0 flex-1 truncate text-small font-semibold text-cg-ink" title={component.path ?? component.name}>
                {component.name}
                {component.path ? <span className="ml-1.5 font-mono font-normal text-cg-muted">{component.path.split("/").pop()}</span> : null}
              </span>
              <span className={`flex-none text-small font-medium ${LEVEL_TONE[component.level]}`}>{LEVEL_LABEL[component.level]}</span>
              <span className="flex-none text-small text-cg-muted tabular-nums" title="Priority score, 0 to 100">
                {component.score}
              </span>
            </div>
            <p className="px-2 pb-1 text-small leading-4 text-cg-muted" id={reasonsId}>
              {component.reasons.join(" · ")}
            </p>
            <ul aria-describedby={reasonsId}>
              {members.length > 0
                ? members.map((unit) => {
                    const change = UNIT_CHANGE[unit.change] ?? UNIT_CHANGE.modified!;
                    const why = unit.reasons.join(" · ");
                    const active = activeUnit === unit.id;
                    return (
                      <li key={unit.id}>
                        <Why text={active ? "" : why}>
                          <button
                            aria-selected={active}
                            className={ROW}
                            type="button"
                            onClick={() => onOpenUnit(unit)}
                          >
                            <MarkGlyph state={marks.get(unit.path)} />
                            <Letter change={change.change} name={unit.change} />
                            <span className="min-w-0 flex-1 truncate">
                              <span className="text-cg-muted">{UNIT_KIND_LABEL[unit.kind] ?? unit.kind} </span>
                              {unit.kind === "file" ? unit.name.split("/").pop() : unit.name.split(".").slice(-1)[0]}
                              {component.path === null ? <span className="ml-1.5 text-cg-muted">{unit.path.split("/").pop()}</span> : null}
                            </span>
                            {unit.signature_changed ? (
                              <span className="flex-none rounded-cg-sm border border-cg-line-strong px-1 font-medium text-cg-ink">
                                signature changed
                              </span>
                            ) : null}
                            <span className="flex-none text-cg-muted tabular-nums">{unit.score}</span>
                          </button>
                        </Why>
                        {active && why ? (
                          <p className="mr-2 mb-1 ml-8 text-small leading-4 text-cg-muted-strong">{why}</p>
                        ) : null}
                      </li>
                    );
                  })
                : component.files.map((path) => (
                    <li key={path}>
                      <Why text={scores.get(path)?.reasons.join(" · ") ?? ""}>
                        <button className={ROW} type="button" onClick={() => onOpenFile(path)}>
                          <MarkGlyph state={marks.get(path)} />
                          <span className="min-w-0 flex-1 truncate">{fileName(path)}</span>
                        </button>
                      </Why>
                    </li>
                  ))}
            </ul>
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
