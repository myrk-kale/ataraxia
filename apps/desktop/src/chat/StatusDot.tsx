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

/**
 * The agent's state as a dot and a word: amber (busy or waiting), red (stopped or failed). The
 * word carries the meaning, so the colour never has to. An agent that is ready says nothing.
 */
export function StatusDot({ status }: { status: SessionStatus }) {
  if (status === "ready" || status === "idle") {
    return null;
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-small text-cg-muted-strong" role="status">
      <span aria-hidden="true" className={`h-1.5 w-1.5 flex-none rounded-full ${COLOR[TONE[status]]}`} />
      {LABEL[status]}
    </span>
  );
}
