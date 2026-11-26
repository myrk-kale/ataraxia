import { ListFilter, LoaderCircle, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/Button";

/** `m:ss`, for how long something has been going. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What a triage that is taking a while says, by how long it has taken. */
export function runningHint(ms: number): string {
  if (ms < 45_000) {
    return "It is reading the changed code to decide what needs a person's eyes. You can keep reviewing meanwhile; the queue updates when it is done.";
  }
  if (ms < 150_000) {
    return "Still reading. A long queue takes a couple of minutes. You can keep reviewing, or cancel and keep the order you have.";
  }
  return "This is taking longer than usual. Cancel to keep the order you have, or leave it a little longer.";
}

/**
 * Orders the review queue with a read-only subagent, and says what it is doing while it works.
 * It sits in plain view at the top of the queue, with what it does written next to it, and while
 * it runs it shows how long it has been going and can be cancelled: it never leaves a spinner
 * with nothing to say. The queue is only changed when it finishes.
 */
export function TriageBar({
  count,
  startedAt,
  note,
  error,
  skipped,
  showSkipped,
  onStart,
  onCancel,
  onUndo,
  onShowSkipped,
}: {
  /** Components in the queue. */
  count: number;
  /** When the running triage began (ms since the epoch); `null` when none is running. */
  startedAt: number | null;
  /** What the last triage did, in a sentence. */
  note: string | null;
  error: string | null;
  skipped: number;
  showSkipped: boolean;
  onStart: () => void;
  onCancel: () => void;
  onUndo: () => void;
  onShowSkipped: (show: boolean) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  if (startedAt !== null) {
    const spent = now - startedAt;
    return (
      <section aria-label="Prioritizing the queue" className="mx-3 mb-2 rounded-cg-md border border-cg-line-strong bg-cg-panel p-3" role="status">
        <div className="flex items-center gap-2">
          <LoaderCircle aria-hidden="true" className="flex-none text-cg-accent motion-safe:animate-spin" size={15} />
          <p className="min-w-0 flex-1 text-small font-semibold text-cg-ink">
            A subagent is reading {count} {count === 1 ? "change" : "changes"}
          </p>
          <span className="flex-none text-small text-cg-muted tabular-nums">{elapsed(spent)}</span>
        </div>
        <p className="mt-1.5 text-small leading-5 text-cg-muted-strong">{runningHint(spent)}</p>
        <Button className="mt-2" size="sm" variant="quiet" onClick={onCancel}>
          <X aria-hidden="true" size={12} />
          Cancel
        </Button>
      </section>
    );
  }

  return (
    <section aria-label="Prioritize the queue" className="mx-3 mb-2 flex flex-col gap-1.5">
      <Button className="w-full justify-start" disabled={count === 0} variant="quiet" onClick={onStart}>
        <ListFilter aria-hidden="true" size={14} />
        Prioritize with a subagent
      </Button>
      {note || error || skipped > 0 ? null : (
        <p className="px-1 text-small leading-5 text-cg-muted">
          Orders the {count} {count === 1 ? "change" : "changes"} and leaves out what needs no review. Your own priorities stay on top.
        </p>
      )}
      {error ? (
        <p className="px-1 text-small leading-5 text-cg-red" role="alert">
          {error}
        </p>
      ) : null}
      {note ? (
        <p aria-live="polite" className="px-1 text-small leading-5 text-cg-muted-strong">
          {note}
        </p>
      ) : null}
      {skipped > 0 || note ? (
        <div className="flex items-center gap-3 px-1">
          {skipped > 0 ? (
            <button
              aria-pressed={showSkipped}
              className="rounded-cg-sm text-small text-cg-muted-strong underline-offset-2 hover:text-cg-ink hover:underline"
              type="button"
              onClick={() => onShowSkipped(!showSkipped)}
            >
              {showSkipped ? `Hide the ${skipped} left out` : `${skipped} left out · show`}
            </button>
          ) : null}
          {skipped > 0 ? (
            <button className="flex items-center gap-1 rounded-cg-sm text-small text-cg-muted-strong hover:text-cg-ink" type="button" onClick={onUndo}>
              <Undo2 aria-hidden="true" size={12} />
              Undo the triage
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
