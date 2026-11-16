import { Check, Loader2, Square, X } from "lucide-react";
import type { SubagentView } from "../lib/agent";
import type { ProviderKind } from "../lib/workspace";
import { ProviderMark } from "./ProviderMark";

/** Running, done and failed differ in shape as well as colour. */
function StatusGlyph({ status }: { status: SubagentView["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 aria-hidden="true" className="flex-none animate-spin text-cg-muted-strong" size={12} />;
    case "failed":
      return <X aria-hidden="true" className="flex-none text-cg-red" size={12} />;
    default:
      return <Check aria-hidden="true" className="flex-none text-cg-green" size={12} />;
  }
}

const STATUS_LABEL: Record<SubagentView["status"], string> = {
  running: "working",
  done: "done",
  failed: "failed",
};

/**
 * A minimal switcher between the main conversation and its subagents. BTW keeps its own writable
 * conversation; the main chip brings the composer back.
 */
export function SubagentBar({
  subagents,
  selected,
  mainLabel,
  provider,
  busy,
  onSelect,
  onClose,
  onStop,
}: {
  subagents: SubagentView[];
  /** The selected subagent id, or null for the main conversation. */
  selected: string | null;
  mainLabel: string;
  /** Which agent the main conversation belongs to, for its mark. */
  provider?: ProviderKind;
  busy: boolean;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
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
        {provider ? <ProviderMark provider={provider} size={16} /> : null}
        <span className="truncate">{mainLabel}</span>
      </button>
      {subagents.map((item) => (
        <div
          key={item.id}
          className={`flex max-w-[240px] flex-none items-center rounded-full border px-1 py-0.5 ${
            selected === item.id
              ? "border-cg-line-strong bg-cg-tint text-cg-ink"
              : "border-transparent text-cg-muted-strong hover:bg-cg-tint hover:text-cg-ink"
          }`}
        >
          <button
            aria-current={selected === item.id ? "true" : undefined}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-small"
            type="button"
            onClick={() => onSelect(item.id)}
          >
            <StatusGlyph status={item.status} />
            <span className="truncate">{item.title}</span>
            <span className="sr-only">{STATUS_LABEL[item.status]}</span>
          </button>
          <button
            aria-label={`Close ${item.title}`}
            className="grid h-6 w-6 flex-none place-items-center rounded-full text-cg-muted hover:bg-cg-line hover:text-cg-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cg-accent"
            title={`Close ${item.title}`}
            type="button"
            onClick={() => onClose(item.id)}
          >
            <X aria-hidden="true" size={12} />
          </button>
        </div>
      ))}
      {busy ? (
        <button
          aria-label="Stop"
          className="ml-auto grid h-6 w-6 flex-none place-items-center rounded-cg-sm text-cg-muted hover:bg-cg-tint hover:text-cg-ink"
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
