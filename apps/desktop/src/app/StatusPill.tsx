import type { SessionStatus } from "../lib/workspace";

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "Idle",
  starting: "Starting",
  ready: "Ready",
  working: "Working",
  "waiting-permission": "Needs approval",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
};

function dotClass(status: SessionStatus | null): string {
  switch (status) {
    case "working":
    case "starting":
    case "stopping":
      return "bg-cg-amber cg-pulse";
    case "waiting-permission":
      return "bg-cg-accent cg-pulse";
    case "failed":
      return "bg-cg-red";
    case "ready":
      return "bg-cg-green";
    default:
      return "bg-cg-line-strong";
  }
}

export function StatusPill({ status }: { status: SessionStatus | null }) {
  return (
    <span
      className="ml-1.5 flex items-center gap-[7px] text-small whitespace-nowrap text-cg-muted-strong"
      role="status"
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dotClass(status)}`} />
      {status ? STATUS_LABEL[status] : "No session"}
    </span>
  );
}
