import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, useInsightEvents } from "../lib/useInsightEvents";
import { workbenchView, type WorkbenchView } from "../lib/workbench";
import { LOADING, READY, type LoadState } from "../ui/State";
import { statusOf } from "./model";

/** How often the board is read while it is on screen and an agent is working, and while nothing moves. */
export const BUSY_EVERY_MS = 3_000;
export const CALM_EVERY_MS = 8_000;
/** And while it is not on screen: only to know whether something waits for the developer. */
export const BACKGROUND_EVERY_MS = 15_000;

/**
 * The board of a workspace, kept fresh: read when the app opens, again whenever the app says
 * something changed, and on a timer (what the agents did to their files is read from git, so it has
 * no event of its own). While the screen is `live` that is every few seconds; away from it, every
 * so often and only when some chat is on the board, so the nav can say that something needs the
 * developer. A board nobody is on is not read at all.
 *
 * A read that fails keeps the board that is already on screen and says so in `stale`: one hiccup
 * should not wipe what somebody is reading.
 */
export function useWorkbench(workspaceId: string | null, live: boolean) {
  const [view, setView] = useState<WorkbenchView | null>(null);
  const [state, setState] = useState<LoadState>(LOADING);
  const [stale, setStale] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const current = useRef(workspaceId);
  const busy = useRef(false);
  const inFlight = useRef(false);
  const again = useRef(false);
  /** How many chats are on the board, once it has been read. */
  const onBoard = useRef<number | null>(null);
  const isLive = useRef(live);
  isLive.current = live;

  useEffect(() => {
    current.current = workspaceId;
    onBoard.current = null;
    setView(null);
    setStale(null);
    setUpdatedAt(null);
    setState(LOADING);
  }, [workspaceId]);

  const load = useCallback(async () => {
    if (!workspaceId) {
      return;
    }
    // A read already under way is followed by one more, not by a pile of them.
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        again.current = false;
        try {
          const next = await workbenchView(workspaceId);
          if (current.current !== workspaceId) {
            return;
          }
          busy.current = next.members.some((member) => statusOf(member).tone === "working");
          onBoard.current = next.members.length;
          setView(next);
          setState(READY);
          setStale(null);
          setUpdatedAt(Date.now());
        } catch (err) {
          if (current.current !== workspaceId) {
            return;
          }
          const message = errorText(err);
          setState((now) => (now.kind === "ready" ? now : { kind: "failed", message }));
          setStale(message);
        }
      } while (again.current);
    } finally {
      inFlight.current = false;
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    let stopped = false;
    let timer: number | undefined;
    const wait = () => (live ? (busy.current ? BUSY_EVERY_MS : CALM_EVERY_MS) : BACKGROUND_EVERY_MS);
    const tick = () => {
      if (stopped) {
        return;
      }
      if (!document.hidden && (live || onBoard.current !== 0)) {
        void load();
      }
      timer = window.setTimeout(tick, wait());
    };
    void load();
    timer = window.setTimeout(tick, live ? BUSY_EVERY_MS : BACKGROUND_EVERY_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [workspaceId, live, load]);

  useInsightEvents((event) => {
    if (event.type === "workbench" && event.workspaceId === current.current && (isLive.current || onBoard.current !== 0)) {
      void load();
    }
  });

  return { view, state, stale, updatedAt, reload: load };
}

/** The time, ticking every `every` ms while `active`, so "3 min ago" keeps up without a read. */
export function useNow(active: boolean, every = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [active, every]);
  return now;
}

/** What the screen reads from the board. */
export type WorkbenchBoard = ReturnType<typeof useWorkbench>;
