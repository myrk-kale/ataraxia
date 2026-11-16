import { Clock, X } from "lucide-react";
import type { Schedule } from "../lib/agent";

/** "every 5 min", "every 2 h", "every day". */
export function everyLabel(secs: number): string {
  if (secs % 86_400 === 0) {
    const days = secs / 86_400;
    return days === 1 ? "every day" : `every ${days} days`;
  }
  if (secs % 3_600 === 0) {
    return `every ${secs / 3_600} h`;
  }
  return `every ${Math.max(1, Math.round(secs / 60))} min`;
}

/** When it runs next, in the reader's own clock: the time today, or the day and the time. */
export function whenLabel(nextRun: number, now: Date = new Date()): string {
  const at = new Date(nextRun * 1000);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/**
 * What the agent asked to be told about later (a release it is waiting on, a retry), with when it
 * comes back. The app keeps it, so it is the same whichever agent the chat uses and it survives a
 * restart. Each can be cancelled here.
 */
export function ScheduledTasks({
  schedules,
  onCancel,
}: {
  schedules: Schedule[];
  onCancel: (id: string) => void;
}) {
  if (schedules.length === 0) {
    return null;
  }
  return (
    <section aria-label="Scheduled" className="mb-2 flex flex-col gap-1.5">
      <p className="px-1 text-small text-cg-muted">
        Scheduled ({schedules.length}). Sent to the agent when the time comes, even after a restart.
      </p>
      <ul className="flex flex-col gap-1">
        {schedules.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-2 rounded-cg-md border border-cg-line bg-cg-tint py-1.5 pr-1.5 pl-3"
          >
            <Clock aria-hidden="true" className="flex-none text-cg-muted" size={13} />
            <span className="min-w-0 flex-1 truncate text-ui text-cg-ink" title={item.prompt}>
              {item.prompt}
            </span>
            <span className="flex-none text-small text-cg-muted-strong tabular-nums">
              {whenLabel(item.next_run)}
              {item.every_secs ? ` · ${everyLabel(item.every_secs)}` : ""}
            </span>
            <button
              aria-label={`Cancel the schedule: ${item.prompt}`}
              className="grid h-6 w-6 flex-none place-items-center rounded-cg-sm text-cg-muted hover:bg-cg-line hover:text-cg-ink"
              title="Cancel this schedule"
              type="button"
              onClick={() => onCancel(item.id)}
            >
              <X aria-hidden="true" size={13} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
