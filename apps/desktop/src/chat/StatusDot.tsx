import type { SessionStatus } from "../lib/workspace";

type Tone = "green" | "yellow" | "red";

const TONE: Record<SessionStatus, Tone> = {
  idle: "green",
  ready: "green",
  starting: "yellow",
  working: "yellow",
  "waiting-permission": "yellow",
  stopping: "yellow",
  stopped: "red",
  failed: "red",
};

const LABEL: Record<SessionStatus, string> = {
  idle: "Idle",
  ready: "Ready",
  starting: "Starting",
  working: "Working",
  "waiting-permission": "Needs approval",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
};

const COLOR: Record<Tone, string> = {
  green: "bg-cg-green",
  yellow: "bg-cg-amber",
  red: "bg-cg-red",
};

/** The colour marks the agent state; its name is available on hover and to screen readers. */
export function StatusDot({ status }: { status: SessionStatus }) {
  return (
    <span className="inline-flex items-center" role="status" aria-label={LABEL[status]} title={LABEL[status]}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 flex-none rounded-full ${COLOR[TONE[status]]}`} />
    </span>
  );
}
