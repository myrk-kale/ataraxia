import { Square } from "lucide-react";
import type { SubagentView } from "../lib/agent";

function dotClass(status: SubagentView["status"]): string {
  switch (status) {
    case "running":
      return "bg-cg-amber cg-pulse";
    case "failed":
      return "bg-cg-red";
    default:
      return "bg-cg-green";
  }
}

const STATUS_LABEL: Record<SubagentView["status"], string> = {
  running: "working",
  done: "done",
  failed: "failed",
};

/**
 * A minimal switcher between the main conversation and the subagents it started. Subagent
 * conversations are read-only; the main chip brings the composer back.
 */
export function SubagentBar({
  subagents,
  selected,
  mainLabel,
  busy,
  onSelect,
  onStop,
}: {
  subagents: SubagentView[];
  /** The selected subagent id, or null for the main conversation. */
  selected: string | null;
  mainLabel: string;
  busy: boolean;
  onSelect: (id: string | null) => void;
  onStop: () => void;
}) {
  if (subagents.length === 0) {
    return null;
  }
  const chip = (active: boolean) =>
    `flex max-w-[200px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-small ${
      active
        ? "border-cg-line-strong bg-cg-tint text-cg-ink"
        : "border-transparent text-cg-muted-strong hover:bg-cg-tint hover:text-cg-ink"
    }`;
  return (
    <nav
      aria-label="Subagents"
      className="mx-auto mb-2 flex w-full max-w-[780px] items-center gap-1 overflow-x-auto px-8"
    >
      <button
        aria-current={selected === null ? "true" : undefined}
        className={chip(selected === null)}
        type="button"
        onClick={() => onSelect(null)}
      >
        <span aria-hidden="true" className="text-cg-accent">
          ✳
        </span>
        <span className="truncate">{mainLabel}</span>
      </button>
      {subagents.map((item) => (
        <button
          key={item.id}
          aria-current={selected === item.id ? "true" : undefined}
          className={chip(selected === item.id)}
          title={`${item.title} (${STATUS_LABEL[item.status]})`}
          type="button"
          onClick={() => onSelect(item.id)}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 flex-none rounded-full ${dotClass(item.status)}`}
          />
          <span className="truncate">{item.title}</span>
          <span className="sr-only">{STATUS_LABEL[item.status]}</span>
        </button>
      ))}
      {busy ? (
        <button
          aria-label="Stop"
          className="ml-auto grid h-6 w-6 flex-none place-items-center rounded-md text-cg-muted hover:bg-cg-tint hover:text-cg-ink"
          title="Stop the running turn"
          type="button"
          onClick={onStop}
        >
          <Square fill="currentColor" size={10} />
        </button>
      ) : null}
    </nav>
  );
}
