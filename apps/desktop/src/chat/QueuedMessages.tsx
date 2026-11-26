import { CornerDownRight, Pause, Play, X } from "lucide-react";
import type { MessageQueue } from "../lib/agent";

/**
 * Messages typed while the agent was working, in the order they will be sent. Each can be sent
 * at once (which stops the running turn) or taken back out, and the queue as a whole can be held
 * so it does not go on by itself (after a /compact, say) and let go on again.
 */
export function QueuedMessages({
  queue,
  onSendNow,
  onRemove,
  onSetPaused,
}: {
  queue: MessageQueue;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
  onSetPaused: (paused: boolean) => void;
}) {
  if (queue.items.length === 0) {
    return null;
  }
  return (
    <section aria-label="Queued messages" className="mb-2 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-small text-cg-muted">
          {queue.paused
            ? queue.reason
              ? `Paused by the agent: ${queue.reason.replace(/[.!?\s]+$/, "")}. Resume, or send one of these now, to carry on.`
              : "Paused: nothing is sent until you resume or send one now."
            : `Queued (${queue.items.length}). Sent one after another when the agent finishes.`}
        </p>
        <button
          className="flex flex-none items-center gap-1 rounded-cg-sm px-2 py-1 text-small text-cg-muted-strong hover:bg-cg-line hover:text-cg-ink"
          title={
            queue.paused
              ? "Let the queue go on: the next message is sent when the agent is free"
              : "Hold the queue: nothing is sent by itself, not even after a /compact"
          }
          type="button"
          onClick={() => onSetPaused(!queue.paused)}
        >
          {queue.paused ? <Play aria-hidden="true" size={12} /> : <Pause aria-hidden="true" size={12} />}
          {queue.paused ? "Resume" : "Pause"}
        </button>
      </div>
      <ol className="flex max-h-[30vh] flex-col gap-1 overflow-y-auto">
        {queue.items.map((item, index) => (
          <li
            key={item.id}
            className="flex items-center gap-2 rounded-cg-md border border-cg-line bg-cg-tint py-1.5 pr-1.5 pl-3"
          >
            <span aria-hidden="true" className="w-4 flex-none text-small text-cg-muted tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-ui text-cg-ink" title={item.text}>
              {item.text || "(images only)"}
              {item.images.length > 0 ? (
                <span className="text-cg-muted-strong">
                  {" "}
                  · {item.images.length} {item.images.length === 1 ? "image" : "images"}
                </span>
              ) : null}
            </span>
            <button
              aria-label={`Send now: ${item.text || "images"}`}
              className="flex flex-none items-center gap-1 rounded-cg-sm px-2 py-1 text-small text-cg-muted-strong hover:bg-cg-line hover:text-cg-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              disabled={item.pending === true}
              title={item.pending ? "Being added to the queue" : "Stop the running turn and send this message now"}
              type="button"
              onClick={() => onSendNow(item.id)}
            >
              <CornerDownRight aria-hidden="true" size={12} />
              Send now
            </button>
            <button
              aria-label={`Remove from the queue: ${item.text || "images"}`}
              className="grid h-6 w-6 flex-none place-items-center rounded-cg-sm text-cg-muted hover:bg-cg-line hover:text-cg-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              disabled={item.pending === true}
              title={item.pending ? "Being added to the queue" : "Remove from the queue"}
              type="button"
              onClick={() => onRemove(item.id)}
            >
              <X aria-hidden="true" size={12} />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
