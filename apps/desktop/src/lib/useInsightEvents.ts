import { useEffect, useRef } from "react";
import { listenInsightEvents, type InsightEvent } from "./insights";

/** Subscribes to pushed changes of derived work (checkpoints, artifacts, decisions, BTW). */
export function useInsightEvents(handler: (event: InsightEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listenInsightEvents((event) => latest.current(event)).then((stop) => {
      if (cancelled) {
        stop();
      } else {
        unlisten = stop;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // Core errors read "error[code]: message"; the code is for programs, the message for people.
  return text.replace(/^error\[[a-z-]+\]:\s*/, "");
}

export function errorCode(err: unknown): string | null {
  const text = err instanceof Error ? err.message : String(err);
  return /^error\[([a-z-]+)\]/.exec(text)?.[1] ?? null;
}
