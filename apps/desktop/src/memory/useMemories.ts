import { useCallback, useEffect, useState } from "react";
import { memorySnapshot, type MemorySnapshot } from "../lib/memory";
import { errorText, useInsightEvents } from "../lib/useInsightEvents";
import { LOADING, READY, type LoadState } from "../ui/State";

/**
 * What is remembered, read while `active` and read again whenever an agent changes it (the app
 * is told as it happens), so an open view never shows a memory that is already gone.
 */
export function useMemories(active: boolean) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [state, setState] = useState<LoadState>(LOADING);

  const load = useCallback(() => {
    return memorySnapshot()
      .then((next) => {
        setSnapshot(next);
        setState(READY);
      })
      .catch((err: unknown) => setState({ kind: "failed", message: errorText(err) }));
  }, []);

  useEffect(() => {
    if (active) {
      setState((current) => (current.kind === "ready" ? current : LOADING));
      void load();
    }
  }, [active, load]);

  useInsightEvents((event) => {
    if (active && event.type === "memories") {
      void load();
    }
  });

  return { snapshot, state, reload: load, setSnapshot };
}
