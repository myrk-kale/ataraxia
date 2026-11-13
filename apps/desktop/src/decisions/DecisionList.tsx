import { CircleCheck, CircleDot, CircleSlash, CircleX, Loader2, Search } from "lucide-react";
import type { MutableRefObject } from "react";
import type { Decision, DecisionState } from "../lib/insights";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { ago, countByTab, filterDecisions, KIND_LABEL, openedBy, STATE_LABEL, type Generation, type Tab } from "./model";

const STATE_TONE: Record<DecisionState, string> = {
  pending: "text-cg-ink",
  approved: "text-cg-green",
  rejected: "text-cg-red",
  superseded: "text-cg-muted-strong",
};

export function StateIcon({ state, size = 16 }: { state: DecisionState; size?: number }) {
  const props = { "aria-hidden": true, className: `flex-none ${STATE_TONE[state]}`, size } as const;
  switch (state) {
    case "approved":
      return <CircleCheck {...props} />;
    case "rejected":
      return <CircleX {...props} />;
    case "superseded":
      return <CircleSlash {...props} />;
    default:
      return <CircleDot {...props} />;
  }
}

/** The state in words and a shape, never in colour alone. */
export function StateBadge({ state }: { state: DecisionState }) {
  const tone: Record<DecisionState, string> = {
    pending: "border-cg-line-strong bg-cg-tint text-cg-ink",
    approved: "border-transparent bg-cg-add-bg text-cg-add-fg",
    rejected: "border-transparent bg-cg-del-bg text-cg-del-fg",
    superseded: "border-cg-line-strong bg-cg-tint text-cg-muted-strong",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-cg-md border px-2 py-0.5 text-small font-medium ${tone[state]}`}>
      <StateIcon size={13} state={state} />
      {STATE_LABEL[state]}
    </span>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
];

/** The decisions of a chat as a list of threads, open ones first, like a repository's issues. */
export function DecisionList({
  decisions,
  tab,
  query,
  generation,
  rows,
  onTab,
  onQuery,
  onOpen,
  onGenerate,
  onNew,
  onRetry,
}: {
  decisions: readonly Decision[];
  tab: Tab;
  query: string;
  generation: Generation;
  rows: MutableRefObject<Map<string, HTMLButtonElement>>;
  onTab: (tab: Tab) => void;
  onQuery: (query: string) => void;
  onOpen: (id: string) => void;
  onGenerate: () => void;
  onNew: () => void;
  onRetry: () => void;
}) {
  const counts = countByTab(decisions);
  const shown = filterDecisions(decisions, tab, query);
  const working = generation.kind === "working";

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[860px] flex-col gap-4 overflow-y-auto px-8 pt-9 pb-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-title leading-snug font-semibold tracking-[-0.3px] text-cg-ink">Decisions</h1>
        <Button disabled={working} variant="secondary" onClick={onGenerate}>
          Generate…
        </Button>
        <Button variant="primary" onClick={onNew}>
          New decision
        </Button>
      </header>

      {generation.kind === "working" ? (
        <p
          aria-live="polite"
          className="flex items-center gap-2 rounded-cg-md bg-cg-tint px-3.5 py-2.5 text-small text-cg-muted-strong"
          role="status"
        >
          <Loader2 aria-hidden="true" className="flex-none animate-spin" size={13} />
          Reading the changes with {generation.label}. New decisions show up here when it finishes.
        </p>
      ) : null}
      {generation.kind === "failed" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-cg-md bg-cg-del-bg px-3.5 py-2.5 text-small text-cg-del-fg" role="alert">
          <span className="min-w-0 flex-1">
            Generating with {generation.label} did not finish: {generation.message}
          </span>
          <Button variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <div aria-label="Show" className="flex items-center gap-1" role="tablist">
          {TABS.map((item) => (
            <button
              key={item.id}
              aria-selected={tab === item.id}
              className="rounded-cg-sm px-2.5 py-1 text-ui text-cg-muted-strong hover:bg-cg-tint aria-selected:bg-cg-tint aria-selected:font-semibold aria-selected:text-cg-ink"
              role="tab"
              type="button"
              onClick={() => onTab(item.id)}
            >
              {item.label} <span className="tabular-nums">{counts[item.id]}</span>
            </button>
          ))}
        </div>
        <label className="relative ml-auto min-w-[180px] flex-1 sm:max-w-[320px]">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-cg-muted" size={13} />
          <input
            aria-label="Search decisions"
            className="w-full rounded-cg-md border border-cg-control bg-cg-panel py-1.5 pr-3 pl-8 text-ui text-cg-ink placeholder:text-cg-muted focus:border-cg-ink"
            placeholder="Search decisions"
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-cg-md border border-cg-line px-4 py-8 text-center text-ui leading-6 text-cg-muted-strong">
          {query.trim()
            ? `No ${tab} decision matches "${query.trim()}".`
            : tab === "open"
              ? counts.closed > 0
                ? "Every decision has a verdict. Closed ones stay under Closed, and a new change can reopen the conversation."
                : "Nothing is open."
              : "No decision has been settled yet."}
        </p>
      ) : (
        <ul aria-label={`${tab === "open" ? "Open" : "Closed"} decisions`} className="flex flex-col divide-y divide-cg-line rounded-cg-lg border border-cg-line">
          {shown.map((decision) => (
            <li key={decision.id}>
              <button
                ref={(node) => {
                  if (node) {
                    rows.current.set(decision.id, node);
                  } else {
                    rows.current.delete(decision.id);
                  }
                }}
                className="flex w-full items-start gap-3 px-4 py-3 text-left first:rounded-t-cg-lg last:rounded-b-cg-lg hover:bg-cg-tint"
                type="button"
                onClick={() => onOpen(decision.id)}
              >
                <span className="pt-0.5">
                  <StateIcon state={decision.state} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-body leading-snug font-semibold text-cg-ink">{decision.title}</span>
                    <Chip>{KIND_LABEL[decision.kind]}</Chip>
                  </span>
                  <span className="text-small leading-5 text-cg-muted-strong">
                    #{decision.seq}{" "}
                    {decision.state === "pending"
                      ? `opened ${ago(decision.created_at)} by ${openedBy(decision)}`
                      : `${STATE_LABEL[decision.state].toLowerCase()} ${ago(decision.updated_at)}, opened by ${openedBy(decision)}`}
                    {decision.refs.length > 0
                      ? ` · ${decision.refs.length} ${decision.refs.length === 1 ? "place" : "places"} in the code`
                      : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
