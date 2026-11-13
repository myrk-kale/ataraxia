import { TextArea } from "@heroui/react";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";
import type { MutableRefObject } from "react";
import type { Decision, DecisionDetail, DecisionState } from "../lib/insights";
import { Button } from "../ui/Button";
import { Tip } from "../ui/Overlay";
import { StateBadge } from "./DecisionList";
import { buildTimeline } from "./model";

/**
 * One decision, and nothing else: what it says, then, at the bottom, what the reviewer can do
 * with it: approve, reject, or comment (with either verdict, or alone). Everything that happened
 * to it is in the thread, one click away.
 */
export function DecisionIssue({
  decision,
  detail,
  position,
  total,
  draft,
  input,
  onDraft,
  onVerdict,
  onComment,
  onBack,
  onStep,
  onOpenThread,
}: {
  decision: Decision;
  detail: DecisionDetail | null;
  position: number;
  total: number;
  draft: string;
  input: MutableRefObject<HTMLTextAreaElement | null>;
  onDraft: (text: string) => void;
  onVerdict: (state: Extract<DecisionState, "pending" | "approved" | "rejected">, comment: string) => void;
  onComment: (text: string) => void;
  onBack: () => void;
  onStep: (delta: -1 | 1) => void;
  onOpenThread: () => void;
}) {
  const settled = decision.state !== "pending";
  const text = draft.trim();
  const updates = detail ? buildTimeline(detail).length : 0;
  const moved = Boolean(detail && detail.laterChanges.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto flex w-full max-w-[640px] flex-col gap-6 px-8 pt-8 pb-6">
          <nav aria-label="Decisions" className="flex items-center text-small text-cg-muted-strong">
            <Button variant="quiet" onClick={onBack}>
              <ArrowLeft aria-hidden="true" size={14} />
              Decisions
            </Button>
            <span className="ml-auto flex items-center gap-1">
              <Tip label="Previous decision (K)">
                <Button aria-label="Previous decision" disabled={position <= 1} variant="icon" onClick={() => onStep(-1)}>
                  <ChevronLeft size={15} />
                </Button>
              </Tip>
              <span aria-live="polite" className="tabular-nums">
                {position} of {total}
              </span>
              <Tip label="Next decision (J)">
                <Button aria-label="Next decision" disabled={position >= total} variant="icon" onClick={() => onStep(1)}>
                  <ChevronRight size={15} />
                </Button>
              </Tip>
            </span>
          </nav>

          <header className="flex flex-col gap-3">
            {settled ? (
              <div>
                <StateBadge state={decision.state} />
              </div>
            ) : null}
            <h1 className="text-title leading-snug font-semibold tracking-[-0.3px] text-cg-ink">{decision.title}</h1>
            <p className="text-body leading-7 text-cg-ink">{decision.summary}</p>
          </header>

          <div>
            <Button variant="quiet" onClick={onOpenThread}>
              Thread
              <span className="text-cg-muted-strong tabular-nums">
                {updates === 1 ? "1 update" : `${updates} updates`}
                {moved ? ", code changed" : ""}
              </span>
            </Button>
          </div>
        </article>
      </div>

      <form
        aria-label="Your verdict"
        className="mx-auto flex w-full max-w-[640px] flex-none flex-col gap-3 px-8 pb-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (text) {
            onComment(text);
          }
        }}
      >
        <TextArea
          ref={input}
          aria-label="Comment"
          className="max-h-[140px] min-h-[64px] text-ui"
          fullWidth
          placeholder={settled ? "Add a comment…" : "Add a comment, with or without a verdict…"}
          rows={2}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && text) {
              event.preventDefault();
              onComment(text);
            }
          }}
        />
        <div className="flex items-center justify-end gap-2">
          <Button disabled={!text} type="submit" variant="quiet">
            Comment
          </Button>
          {settled ? (
            <Button variant="secondary" onClick={() => onVerdict("pending", text)}>
              <RotateCcw aria-hidden="true" size={14} />
              Reopen
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => onVerdict("rejected", text)}>
                <X aria-hidden="true" className="text-cg-red" size={14} />
                Reject
              </Button>
              <Button variant="secondary" onClick={() => onVerdict("approved", text)}>
                <Check aria-hidden="true" className="text-cg-green" size={14} />
                Approve
              </Button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
