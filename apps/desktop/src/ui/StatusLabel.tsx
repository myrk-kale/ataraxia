import { Check, CircleAlert, Clock, Loader2, RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import type { ArtifactStatus } from "../lib/insights";

const LABEL: Record<ArtifactStatus, string> = {
  queued: "Waiting",
  running: "Working",
  ready: "Ready",
  failed: "Failed",
  stale: "Out of date",
};

const TONE: Record<ArtifactStatus, string> = {
  queued: "text-cg-muted-strong",
  running: "text-cg-muted-strong",
  ready: "text-cg-green",
  failed: "text-cg-red",
  stale: "text-cg-amber-text",
};

function glyph(status: ArtifactStatus): ReactNode {
  switch (status) {
    case "queued":
      return <Clock aria-hidden="true" size={12} />;
    case "running":
      return <Loader2 aria-hidden="true" className="animate-spin" size={12} />;
    case "ready":
      return <Check aria-hidden="true" size={12} />;
    case "failed":
      return <X aria-hidden="true" size={12} />;
    case "stale":
      return <RefreshCw aria-hidden="true" size={12} />;
    default:
      return <CircleAlert aria-hidden="true" size={12} />;
  }
}

/** The state of derived work as an icon and a word, so it never depends on colour alone. */
export function StatusLabel({ status }: { status: ArtifactStatus }) {
  return (
    <span className={`inline-flex flex-none items-center gap-1 text-small font-medium ${TONE[status]}`}>
      {glyph(status)}
      {LABEL[status]}
    </span>
  );
}
