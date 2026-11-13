import { TextArea } from "@heroui/react";
import { GitCommitHorizontal, Loader2, Unlink } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { Decision, DecisionDetail } from "../lib/insights";
import { Button } from "../ui/Button";
import { Dialog, Tip } from "../ui/Overlay";
import { ago, buildTimeline, KIND_LABEL, refLabel, type TimelineEvent } from "./model";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-small font-semibold text-cg-muted-strong">{title}</h3>
      <div className="text-ui leading-6 text-cg-ink">{children}</div>
    </section>
  );
}

function Update({ event, onUnlink }: { event: TimelineEvent; onUnlink: (rev: string) => void }) {
  if (event.kind === "message") {
    const { message } = event;
    const who = message.author === "user" ? "You" : message.author === "agent" ? "Agent" : "System";
    return (
      <li className="flex flex-col gap-0.5">
        <span className="text-small text-cg-muted-strong">
          <span className="font-semibold text-cg-ink">{who}</span> {ago(message.created_at)}
        </span>
        <p className={`text-ui leading-6 whitespace-pre-wrap ${message.author === "system" ? "text-cg-muted-strong" : "text-cg-ink"}`}>
          {message.text}
        </p>
      </li>
    );
  }
  if (event.kind === "commit") {
    const { commit } = event;
    return (
      <li className="flex items-start gap-2 text-small leading-5 text-cg-muted-strong">
        <GitCommitHorizontal aria-hidden="true" className="mt-0.5 flex-none" size={14} />
        <span className="min-w-0 flex-1">
          <span className="text-cg-ink">
            {commit.linked_by === "agent" ? "The agent" : "You"} linked <span className="font-mono">{commit.short}</span>
          </span>{" "}
          {commit.subject}
          {commit.note ? <span className="block text-cg-ink">{commit.note}</span> : null}
          <span className="block">{ago(commit.created_at)}</span>
        </span>
        <Tip label={`Unlink ${commit.short}`}>
          <Button aria-label={`Unlink commit ${commit.short}`} variant="icon" onClick={() => onUnlink(commit.rev)}>
            <Unlink size={13} />
          </Button>
        </Tip>
      </li>
    );
  }
  return (
    <li className="text-small text-cg-muted-strong">
      {event.text} <span>{ago(event.at)}</span>
    </li>
  );
}

/**
 * The thread of a decision, in a modal: the updates in the order they happened, what the
 * decision is about, and the two things that belong to it beyond a verdict: linking a commit and
 * asking the agent (read-only) or asking it to change the code.
 */
export function ThreadDialog({
  isOpen,
  decision,
  detail,
  waiting,
  ask,
  onAsk,
  onSend,
  onClose,
  onOpenFile,
  onLinkCommit,
  onUnlinkCommit,
  onRequestChange,
}: {
  isOpen: boolean;
  decision: Decision;
  detail: DecisionDetail | null;
  waiting: boolean;
  ask: string;
  onAsk: (text: string) => void;
  onSend: () => void;
  onClose: () => void;
  onOpenFile: (path: string, line: number | null) => void;
  onLinkCommit: () => void;
  onUnlinkCommit: (rev: string) => void;
  onRequestChange: () => void;
}) {
  const timeline = detail ? buildTimeline(detail) : [];
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // The Ask button turns off while the agent answers: keep the focus in the field, so Esc still closes the modal.
  const send = () => {
    onSend();
    requestAnimationFrame(() => field.current?.focus());
  };
  const hasAbout =
    decision.context ||
    decision.rationale ||
    decision.alternatives.length > 0 ||
    decision.refs.length > 0 ||
    Boolean(detail && detail.laterChanges.length > 0);

  // It opens on the newest update, and follows the conversation when a new one arrives.
  useEffect(() => {
    if (isOpen && list.current) {
      list.current.scrollTop = list.current.scrollHeight;
    }
  }, [isOpen, timeline.length, waiting]);

  return (
    <Dialog isOpen={isOpen} label="Thread" size="md" onClose={onClose}>
      <div className="flex max-h-[80vh] min-h-0 w-full flex-col">
        <header className="flex flex-col gap-0.5 px-6 pt-5 pb-3">
          <h2 className="text-heading font-semibold text-cg-ink">Thread</h2>
          <p className="truncate text-small text-cg-muted-strong">
            #{decision.seq} {decision.title}
          </p>
        </header>

        <div ref={list} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto border-y border-cg-line px-6 py-4">
          {detail && detail.laterChanges.length > 0 ? (
            <p className="rounded-cg-md bg-cg-tint px-3.5 py-2.5 text-small leading-5 text-cg-muted-strong">
              The code behind this decision changed again in{" "}
              {detail.laterChanges.map((change) => `checkpoint #${change.seq}`).join(", ")}. The thread stays open: link
              the commit that changes the answer.
            </p>
          ) : null}

          {hasAbout ? (
            <details className="flex flex-col gap-3">
              <summary className="flex min-h-7 items-center text-small font-semibold text-cg-muted-strong">About this decision</summary>
              <div className="mt-3 flex flex-col gap-3">
                <Section title="Kind">{KIND_LABEL[decision.kind]}</Section>
                {decision.context ? <Section title="Context">{decision.context}</Section> : null}
                {decision.rationale ? <Section title="Why this option">{decision.rationale}</Section> : null}
                {decision.alternatives.length > 0 ? (
                  <Section title="Alternatives">
                    <ul className="flex flex-col gap-1">
                      {decision.alternatives.map((alternative) => (
                        <li key={alternative.title}>
                          <span className="font-medium">{alternative.title}</span>
                          {alternative.note ? <span className="text-cg-muted-strong">: {alternative.note}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
                {decision.refs.length > 0 ? (
                  <Section title="Code">
                    <ul className="flex flex-col gap-0.5">
                      {decision.refs.map((ref) => (
                        <li key={refLabel(ref)}>
                          <button
                            className="max-w-full truncate text-left font-mono text-small text-cg-accent hover:underline"
                            title={refLabel(ref)}
                            type="button"
                            onClick={() => onOpenFile(ref.path, ref.start_line)}
                          >
                            {refLabel(ref)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
              </div>
            </details>
          ) : null}

          <section aria-label="Updates">
            <h3 className="sr-only">Updates</h3>
            {timeline.length === 0 && !waiting ? (
              <p className="text-small leading-5 text-cg-muted-strong">
                No updates yet. Comments, verdicts and linked commits show up here, in order.
              </p>
            ) : (
              <ul className="flex flex-col gap-4">
                {timeline.map((event, index) => (
                  <Update key={`${event.kind}-${event.at}-${index}`} event={event} onUnlink={onUnlinkCommit} />
                ))}
                {waiting ? (
                  <li aria-live="polite" className="flex items-center gap-2 text-small text-cg-muted-strong">
                    <Loader2 aria-hidden="true" className="animate-spin" size={13} />
                    The agent is reading the code…
                  </li>
                ) : null}
              </ul>
            )}
          </section>
        </div>

        <footer className="flex flex-col gap-3 px-6 py-4">
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <TextArea
              ref={field}
              aria-label="Ask the agent about this decision"
              className="max-h-[100px] min-h-[40px] flex-1 text-ui"
              fullWidth
              placeholder="Ask the agent (it only reads)…"
              rows={1}
              value={ask}
              onChange={(event) => onAsk(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <Button disabled={!ask.trim() || waiting} type="submit" variant="primary">
              Ask
            </Button>
          </form>
          <div className="flex items-center gap-2">
            <Button variant="quiet" onClick={onLinkCommit}>
              Link a commit…
            </Button>
            <Button variant="quiet" onClick={onRequestChange}>
              Request a change…
            </Button>
          </div>
        </footer>
      </div>
    </Dialog>
  );
}
