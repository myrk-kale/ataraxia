import { Check, ChevronLeft, ChevronRight, CircleCheck, CircleDot, CircleX, FileCode, Maximize2, RotateCcw, Scale, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  artifactsList,
  decisionSetState,
  decisionsList,
  type Decision,
  type DecisionState,
} from "../lib/insights";
import { errorText, useInsightEvents } from "../lib/useInsightEvents";
import type { SessionId } from "../lib/workspace";
import { Button } from "../ui/Button";
import { Dialog, Tip } from "../ui/Overlay";
import { LOADING, READY, StateMessage, type LoadState } from "../ui/State";
import { generationState, KIND_LABEL, nextPendingDecision, orderDecisions, refLabel, STATE_LABEL, type Generation } from "./model";
import { canReject, cardLabel, reviewOrder, tally } from "./review";

/** The decisions of one chat, read and kept fresh as they change. */
export function useDecisions(sessionId: SessionId | null) {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [generation, setGeneration] = useState<Generation>({ kind: "idle" });
  const [state, setState] = useState<LoadState>(LOADING);

  const load = useCallback(async () => {
    if (!sessionId) {
      setDecisions([]);
      setGeneration({ kind: "idle" });
      setState(READY);
      return;
    }
    try {
      const [list, artifacts] = await Promise.all([decisionsList(sessionId), artifactsList(sessionId)]);
      setDecisions(list);
      setGeneration(generationState(artifacts));
      setState(READY);
    } catch (err) {
      setState({ kind: "failed", message: errorText(err) });
    }
  }, [sessionId]);

  useEffect(() => {
    setState(LOADING);
    void load();
  }, [load]);

  useInsightEvents((event) => {
    if ((event.type === "decisions" || event.type === "artifact" || event.type === "cleared") && event.sessionId === sessionId) {
      void load();
    }
  });

  async function verdict(decision: Decision, next: DecisionState, comment: string | null) {
    const updated = await decisionSetState(decision.id, next, comment);
    setDecisions((list) => list.map((item) => (item.id === updated.id ? updated : item)));
  }

  return { decisions, generation, state, load, verdict };
}

export function DecisionsCard({
  review,
  decisions,
  onOpenFile,
  onOpenFullscreen,
}: {
  review: ReturnType<typeof useDecisions>;
  decisions: readonly Decision[];
  onOpenFullscreen?: () => void;
  onOpenFile?: (path: string, line: number | null) => void;
}) {
  const { generation, state, load, verdict } = review;
  const [error, setError] = useState<string | null>(null);
  const counts = tally(decisions);
  if (counts.total === 0 && generation.kind !== "working" && state.kind !== "failed") {
    return null;
  }
  const label = counts.total > 0
    ? cardLabel(counts)
    : generation.kind === "working"
      ? `Recording with ${generation.label}…`
      : "Could not load decisions";

  async function submitVerdict(decision: Decision, next: DecisionState, comment: string | null) {
    setError(null);
    try {
      await verdict(decision, next, comment);
    } catch (err) {
      setError(errorText(err));
      throw err;
    }
  }

  return (
    <div className="relative max-w-[680px] min-w-0">
      <details className="group min-w-0 rounded-cg-md border border-cg-line bg-cg-panel text-small hover:bg-cg-sidebar open:bg-cg-panel">
        <summary className={`flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded-cg-md py-2.5 pl-3.5 [&::-webkit-details-marker]:hidden ${onOpenFullscreen ? "pr-12" : "pr-3.5"}`}>
          <ChevronRight aria-hidden="true" className="shrink-0 text-cg-muted motion-safe:transition-transform group-open:rotate-90" size={14} />
          <span className="font-mono font-semibold text-cg-ink">Decisions</span>
          <span className="min-w-0 text-cg-muted-strong">{label}</span>
        </summary>
        <div className="space-y-3 border-t border-cg-line px-3.5 py-3">
          {error ? <p className="text-cg-red" role="alert">{error}</p> : null}
          {state.kind === "failed" ? (
            <StateMessage text={`Could not load the decisions: ${state.message}`} tone="failed">
              <Button variant="secondary" onClick={() => void load()}>Try again</Button>
            </StateMessage>
          ) : null}
          {counts.total > 0 ? (
            <ol className="divide-y divide-cg-line">
              {reviewOrder(decisions).map((decision) => (
                <DecisionCard
                  key={decision.id}
                  decision={decision}
                  inline
                  onOpenFile={onOpenFile}
                  onVerdict={(next, comment) => submitVerdict(decision, next, comment)}
                />
              ))}
            </ol>
          ) : generation.kind === "working" ? (
            <StateMessage text={`Recording decisions with ${generation.label}…`} tone="loading" />
          ) : null}
        </div>
      </details>
      {onOpenFullscreen ? (
        <Tip className="absolute top-1.5 right-2 inline-flex" label="Open decisions full screen">
          <Button aria-label="Open decisions full screen" variant="icon" onClick={onOpenFullscreen}>
            <Maximize2 aria-hidden="true" size={14} />
          </Button>
        </Tip>
      ) : null}
    </div>
  );
}

function StateMark({ state }: { state: DecisionState }) {
  const shape =
    state === "approved" ? (
      <CircleCheck aria-hidden="true" className="text-cg-green" size={14} />
    ) : state === "rejected" ? (
      <CircleX aria-hidden="true" className="text-cg-red" size={14} />
    ) : (
      <CircleDot aria-hidden="true" className="text-cg-muted-strong" size={14} />
    );
  return (
    <span className="inline-flex items-center gap-1 text-small font-medium text-cg-muted-strong">
      {shape}
      {STATE_LABEL[state]}
    </span>
  );
}

export function DecisionsReview({
  isOpen,
  sessionId,
  searchId,
  onClose,
  onOpenFile,
  onError,
}: {
  isOpen: boolean;
  sessionId: SessionId | null;
  searchId?: string | null;
  onClose: () => void;
  onOpenFile: (path: string, line: number | null) => void;
  onError: (message: string) => void;
}) {
  const { decisions, generation, state, load, verdict } = useDecisions(isOpen ? sessionId : null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const shown = orderDecisions(decisions.filter((item) => item.state !== "superseded" || item.id === searchId));
  const counts = tally(decisions);
  const current = shown.find((item) => item.id === (selectedId ?? searchId))
    ?? shown.find((item) => item.state === "pending")
    ?? shown[0];
  const position = current ? shown.indexOf(current) : -1;
  const heading = useRef<HTMLHeadingElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedId(null);
  }, [isOpen, sessionId, searchId]);

  useEffect(() => {
    if (isOpen && state.kind === "ready" && heading.current) {
      if (scrollArea.current) scrollArea.current.scrollTop = 0;
      heading.current.focus({ preventScroll: true });
    }
  }, [isOpen, current?.id, state.kind]);

  async function submitVerdict(decision: Decision, next: DecisionState, comment: string | null) {
    try {
      await verdict(decision, next, comment);
      const target = next === "pending" ? decision.id : nextPendingDecision(shown, decision.id) ?? decision.id;
      setSelectedId((selected) => selected === null || selected === decision.id ? target : selected);
    } catch (err) {
      onError(errorText(err));
      throw err;
    }
  }

  function body() {
    if (state.kind === "loading") {
      return <StateMessage text="Loading the decisions of this chat…" tone="loading" />;
    }
    if (state.kind === "failed") {
      return (
        <StateMessage text={`Could not load the decisions: ${state.message}`} tone="failed">
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </StateMessage>
      );
    }
    if (!current) {
      return (
        <StateMessage
          text={
            generation.kind === "working"
              ? `Recording decisions with ${generation.label}…`
              : "No decisions yet. Ask the chat to record the choices in its work that deserve your verdict."
          }
          tone={generation.kind === "working" ? "loading" : undefined}
        />
      );
    }
    return (
      <>
        <nav aria-label="Decision navigation" className="flex items-center justify-end gap-1 text-small text-cg-muted-strong">
          <Button aria-label="Previous decision" disabled={position <= 0} variant="icon" onClick={() => setSelectedId(shown[position - 1].id)}>
            <ChevronLeft aria-hidden="true" size={16} />
          </Button>
          <span aria-live="polite" className="px-1 tabular-nums">{position + 1} / {shown.length}</span>
          <Button aria-label="Next decision" disabled={position >= shown.length - 1} variant="icon" onClick={() => setSelectedId(shown[position + 1].id)}>
            <ChevronRight aria-hidden="true" size={16} />
          </Button>
        </nav>
        <ol>
          <DecisionCard
            key={current.id}
            headingRef={heading}
            decision={current}
            onOpenFile={(path, line) => {
              onClose();
              onOpenFile(path, line);
            }}
            onVerdict={(next, comment) => submitVerdict(current, next, comment)}
          />
        </ol>
      </>
    );
  }

  const done = counts.total > 0 && counts.pending === 0;

  return (
    <Dialog className="h-full max-h-none w-full max-w-none rounded-none border-0" isOpen={isOpen} label="Decisions" size="full" onClose={onClose}>
      <div className="flex h-full min-h-0 w-full flex-col">
        <header className="flex flex-none items-center gap-3 border-b border-cg-line px-4 py-3.5 sm:px-8">
          <Scale aria-hidden="true" className="text-cg-muted-strong" size={16} />
          <h1 className="text-ui font-semibold text-cg-ink">Decisions</h1>
          {counts.total > 0 ? (
            <span aria-live="polite" className="text-small text-cg-muted-strong">
              {cardLabel(counts)}
            </span>
          ) : null}
          <Button aria-label="Close the decisions" className="ml-auto" variant="icon" onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </Button>
        </header>
        <div ref={scrollArea} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[640px] flex-col gap-5 px-4 pt-8 pb-12 sm:px-8">
            {done ? (
              <p className="rounded-cg-md bg-cg-tint px-4 py-3 text-small leading-5 text-cg-ink" role="status">
                {counts.rejected > 0
                  ? "All reviewed. The agent was sent what you rejected, with your comments."
                  : "All reviewed and approved. The agent was told everything is fine."}
              </p>
            ) : null}
            {body()}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function DecisionCard({
  headingRef,
  decision,
  inline = false,
  onVerdict,
  onOpenFile,
}: {
  headingRef?: React.Ref<HTMLHeadingElement>;
  decision: Decision;
  inline?: boolean;
  onVerdict: (state: DecisionState, comment: string | null) => Promise<void>;
  onOpenFile?: (path: string, line: number | null) => void;
}) {
  const commentId = useId();
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const settled = decision.state !== "pending";

  useEffect(() => {
    if (rejecting) {
      field.current?.focus();
    }
  }, [rejecting]);

  async function decide(next: DecisionState, text: string | null) {
    setBusy(true);
    try {
      await onVerdict(next, text);
      setRejecting(false);
      setComment("");
    } catch {
      // The notice says why; the card stays as it was so nothing typed is lost.
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className={`flex min-w-0 flex-col [overflow-wrap:anywhere] ${
        inline ? "gap-3 py-3 first:pt-0 last:pb-0" : "gap-4 pb-6"
      }`}
    >
      <div className="flex items-center gap-2 text-small text-cg-muted-strong">
        <span className="font-mono">#{decision.seq}</span>
        <span>{KIND_LABEL[decision.kind]}</span>
        <span className="ml-auto">
          <StateMark state={decision.state} />
        </span>
      </div>
      <h2 ref={headingRef} tabIndex={inline ? undefined : -1} className={`leading-snug font-semibold text-cg-ink ${inline ? "text-body" : "text-title"}`}>
        {decision.title}
      </h2>
      <p className="text-ui leading-6 text-cg-ink">{decision.summary}</p>
      {decision.context ? (
        <p className="text-ui leading-6 text-cg-muted-strong">
          <span className="font-medium text-cg-ink">Context. </span>
          {decision.context}
        </p>
      ) : null}
      {decision.rationale ? (
        <p className="text-ui leading-6 text-cg-muted-strong">
          <span className="font-medium text-cg-ink">Why. </span>
          {decision.rationale}
        </p>
      ) : null}
      {decision.alternatives.length > 0 ? (
        <ul className="flex flex-col gap-1 text-small leading-5 text-cg-muted-strong">
          {decision.alternatives.map((alternative) => (
            <li key={alternative.title}>
              <span className="font-medium text-cg-ink">Instead: {alternative.title}</span>
              {alternative.note ? `. ${alternative.note}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {onOpenFile && decision.refs.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {decision.refs.map((ref) => (
            <button
              key={refLabel(ref)}
              aria-label={`Open ${refLabel(ref)} in Code`}
              className={`inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-cg-sm font-mono text-small text-cg-muted-strong hover:text-cg-ink ${
                inline ? "py-1 underline-offset-4 hover:underline" : "border border-cg-line px-2 py-0.5 hover:border-cg-line-strong"
              }`}
              title={refLabel(ref)}
              type="button"
              onClick={() => onOpenFile(ref.path, ref.start_line)}
            >
              <FileCode aria-hidden="true" className="shrink-0" size={13} />
              <span className="min-w-0 truncate">{inline ? refLabel(ref).split("/").at(-1) : refLabel(ref)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {decision.state === "superseded" ? null : rejecting ? (
        <form
          aria-label={`Reject decision #${decision.seq}`}
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (canReject(comment)) {
              void decide("rejected", comment.trim());
            }
          }}
        >
          <label className="text-small font-medium text-cg-ink" htmlFor={commentId}>
            Why do you reject it? The agent gets this comment.
          </label>
          <textarea
            ref={field}
            className="min-h-[72px] w-full resize-y rounded-cg-md border border-cg-control bg-cg-panel px-3 py-2 text-ui leading-6 text-cg-ink placeholder:text-cg-muted focus:border-cg-ink"
            id={commentId}
            placeholder="What should be different"
            required
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canReject(comment)) {
                event.preventDefault();
                void decide("rejected", comment.trim());
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                setRejecting(false);
              }
            }}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={busy} variant="quiet" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !canReject(comment)} type="submit" variant="secondary">
              <X aria-hidden="true" className="text-cg-red" size={14} />
              Reject with this comment
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex justify-end gap-2">
          {settled ? (
            <Button disabled={busy} variant="quiet" onClick={() => void decide("pending", null)}>
              <RotateCcw aria-hidden="true" size={13} />
              Reopen
            </Button>
          ) : (
            <>
              <Button disabled={busy} variant="secondary" onClick={() => setRejecting(true)}>
                <X aria-hidden="true" className="text-cg-red" size={14} />
                Reject
              </Button>
              <Button disabled={busy} variant="secondary" onClick={() => void decide("approved", null)}>
                <Check aria-hidden="true" className="text-cg-green" size={14} />
                Approve
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
