import { useEffect, useState } from "react";
import { scheduleList, type Schedule } from "../lib/agent";
import { listenInsightEvents } from "../lib/insights";
import type { SessionId } from "../lib/workspace";

/**
 * What a chat has scheduled for later. It lives in the backend (the agents create it through the
 * local API), so it is read when the chat opens and follows its change events.
 */
export function useSchedules(sessionId: SessionId): Schedule[] {
  const [schedules, setSchedules] = useState<Schedule[]>([]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    setSchedules([]);
    void (async () => {
      unlisten = await listenInsightEvents((event) => {
        if (event.type === "schedules" && event.sessionId === sessionId) {
          setSchedules(event.schedules);
        }
      });
      if (disposed) {
        unlisten();
        return;
      }
      try {
        const current = await scheduleList(sessionId);
        if (!disposed) {
          setSchedules(current);
        }
      } catch {
        // What cannot be read is shown as nothing scheduled; the next change event corrects it.
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId]);

  return schedules;
}
