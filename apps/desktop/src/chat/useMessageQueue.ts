import { useEffect, useState } from "react";
import { agentQueue, EMPTY_QUEUE, type MessageQueue } from "../lib/agent";
import { listenInsightEvents } from "../lib/insights";
import type { SessionId } from "../lib/workspace";

/**
 * What a chat has waiting for the agent to finish. The queue lives in the backend, so it is read
 * when the chat opens and follows its change events; it keeps going while another chat is open.
 */
export function useMessageQueue(sessionId: SessionId): [MessageQueue, (queue: MessageQueue) => void] {
  const [queue, setQueue] = useState<MessageQueue>(EMPTY_QUEUE);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    setQueue(EMPTY_QUEUE);
    void (async () => {
      unlisten = await listenInsightEvents((event) => {
        if (event.type === "queue" && event.sessionId === sessionId) {
          setQueue(event.queue);
        }
      });
      if (disposed) {
        unlisten();
        return;
      }
      try {
        const current = await agentQueue(sessionId);
        if (!disposed) {
          setQueue(current);
        }
      } catch {
        // A queue that cannot be read is shown as empty; adding to it reports the real error.
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId]);

  return [queue, setQueue];
}
