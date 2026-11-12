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

/** Minimal harness status: green (ready), yellow (busy or waiting), red (stopped or failed). */
export function StatusDot({ status }: { status: SessionStatus }) {
  const tone = TONE[status];
  return (
    <span
      aria-label={LABEL[status]}
      className={`h-1.5 w-1.5 rounded-full ${COLOR[tone]} ${tone === "yellow" ? "cg-pulse" : ""}`}
      role="status"
      title={LABEL[status]}
    />
  );
}
