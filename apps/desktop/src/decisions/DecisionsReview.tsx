import { Check, CircleCheck, CircleDot, CircleX, FileCode, RotateCcw, Scale, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Dialog } from "../ui/Overlay";
import { LOADING, READY, StateMessage, type LoadState } from "../ui/State";
import { generationState, KIND_LABEL, refLabel, STATE_LABEL, type Generation } from "./model";
import { canReject, cardLabel, reviewOrder, tally } from "./review";

/** The decisions of one chat, read and kept fresh as they change. */
function useDecisions(sessionId: SessionId | null) {
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

  return { decisions, setDecisions, generation, state, load };
}

/**
 * The decisions of a chat as an artifact of the conversation: a card that appears once the agent
 * recorded some, and opens the review. Nothing shows while there are none.
 */
export function DecisionsCard({ sessionId, onOpen }: { sessionId: SessionId; onOpen: () => void }) {
  const { decisions, generation } = useDecisions(sessionId);
  const counts = useMemo(() => tally(decisions), [decisions]);
  if (counts.total === 0 && generation.kind !== "working") {
    return null;
  }
  const label = counts.total === 0 ? `Recording decisions with ${generation.kind === "working" ? generation.label : "the agent"}…` : cardLabel(counts);
  return (
    <div className="mx-auto mb-2 flex w-full max-w-[780px] px-8">
      <button
        className={`flex items-center gap-2 rounded-cg-md border px-3 py-1.5 text-small hover:bg-cg-tint ${
          counts.pending > 0 ? "border-cg-line-strong text-cg-ink" : "border-cg-line text-cg-muted-strong"
        }`}
        title="Open the decisions to approve or reject them"
        type="button"
        onClick={onOpen}
      >
        <Scale aria-hidden="true" size={14} />
        <span className="font-medium">Decisions</span>
        <span>{label}</span>
      </button>
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

/**
 * The review, full screen and nothing else on it: one card per decision with what was chosen and
 * why, and two verdicts. A rejection needs a comment. When the last open decision gets its
 * verdict, Ataraxia tells the main agent how the review went: that everything was approved, or
 * what was rejected and why.
 */
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
  const { decisions, setDecisions, generation, state, load } = useDecisions(isOpen ? sessionId : null);
  const shown = useMemo(() => {
    const current = reviewOrder(decisions);
    const archived = decisions.find((decision) => decision.id === searchId && decision.state === "superseded");
    return archived ? [...current, archived] : current;
  }, [decisions, searchId]);
  const counts = useMemo(() => tally(decisions), [decisions]);
  const searchCard = useRef<HTMLLIElement>(null);
  const found = shown.some((decision) => decision.id === searchId);
  useEffect(() => {
    if (isOpen && found) {
      searchCard.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [isOpen, found, searchId, state.kind]);

  async function verdict(decision: Decision, next: DecisionState, comment: string | null) {
    try {
      const updated = await decisionSetState(decision.id, next, comment);
      setDecisions((list) => list.map((item) => (item.id === updated.id ? updated : item)));
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
    if (shown.length === 0) {
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
      <ol className="flex flex-col gap-4">
        {shown.map((decision) => (
          <DecisionCard
            key={decision.id}
            cardRef={decision.id === searchId ? searchCard : undefined}
            decision={decision}
            onOpenFile={(path, line) => {
              onClose();
              onOpenFile(path, line);
            }}
            onVerdict={(next, comment) => verdict(decision, next, comment)}
          />
        ))}
      </ol>
    );
  }

  const done = counts.total > 0 && counts.pending === 0;

  return (
    <Dialog className="h-full max-h-none w-full max-w-none rounded-none border-0" isOpen={isOpen} label="Decisions" size="full" onClose={onClose}>
      <div className="flex h-full min-h-0 w-full flex-col">
        <header className="flex flex-none items-center gap-3 border-b border-cg-line px-8 py-3.5">
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
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-8 pt-8 pb-12">
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
  cardRef,
  decision,
  onVerdict,
  onOpenFile,
}: {
  cardRef?: React.Ref<HTMLLIElement>;
  decision: Decision;
  onVerdict: (state: DecisionState, comment: string | null) => Promise<void>;
  onOpenFile: (path: string, line: number | null) => void;
}) {
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
    <li ref={cardRef} className={`flex flex-col gap-3 rounded-cg-lg border px-5 py-4 ${settled ? "border-cg-line" : "border-cg-line-strong"} ${cardRef ? "outline-1 outline-cg-accent" : ""}`}>
      <div className="flex items-center gap-2 text-small text-cg-muted-strong">
        <span className="font-mono">#{decision.seq}</span>
        <span>{KIND_LABEL[decision.kind]}</span>
        <span className="ml-auto">
          <StateMark state={decision.state} />
        </span>
      </div>
      <h2 className="text-body leading-snug font-semibold text-cg-ink">{decision.title}</h2>
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
      {decision.refs.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {decision.refs.map((ref) => (
            <button
              key={refLabel(ref)}
              className="inline-flex items-center gap-1 rounded-cg-sm border border-cg-line px-2 py-0.5 font-mono text-small text-cg-muted-strong hover:border-cg-line-strong hover:text-cg-ink"
              title="Open in Code"
              type="button"
              onClick={() => onOpenFile(ref.path, ref.start_line)}
            >
              <FileCode aria-hidden="true" size={12} />
              {refLabel(ref)}
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
          <label className="text-small font-medium text-cg-ink" htmlFor={`reject-${decision.id}`}>
            Why do you reject it? The agent gets this comment.
          </label>
          <textarea
            ref={field}
            className="min-h-[72px] w-full resize-y rounded-cg-md border border-cg-control bg-cg-panel px-3 py-2 text-ui leading-6 text-cg-ink placeholder:text-cg-muted focus:border-cg-ink"
            id={`reject-${decision.id}`}
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
          <div className="flex justify-end gap-2">
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
