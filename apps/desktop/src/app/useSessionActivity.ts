import { useEffect, useState } from "react";
import { agentGetSnapshot, listenAgentEvents } from "../lib/agent";
import { artifactsList } from "../lib/insights";
import { useInsightEvents } from "../lib/useInsightEvents";
import type { SessionId, SessionStatus } from "../lib/workspace";

export type SessionActivity = {
  status: SessionStatus | null;
  /** The agent is blocked until the person approves or denies a tool call. */
  needsApproval: boolean;
};

const IDLE: SessionActivity = { status: null, needsApproval: false };

/**
 * What the agent of the open chat is doing, for the whole window. The chat screen owns the
 * conversation, but the person is often in Code or Decisions while the agent works, and an
 * agent waiting for approval has to be visible from there too.
 */
export function useSessionActivity(sessionId: SessionId | null): SessionActivity {
  const [activity, setActivity] = useState<SessionActivity>(IDLE);

  useEffect(() => {
    setActivity(IDLE);
    if (!sessionId) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenAgentEvents((event) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      if (event.type === "status") {
        setActivity((now) => ({ ...now, status: event.status }));
      } else if (event.type === "permission") {
        setActivity((now) => ({ ...now, needsApproval: true }));
      } else if (event.type === "turnDone" || event.type === "error") {
        setActivity((now) => ({ ...now, needsApproval: false }));
      }
    }).then((stop) => {
      if (disposed) {
        stop();
      } else {
        unlisten = stop;
      }
    });
    // A session that is already running (or blocked) when the window opens it.
    agentGetSnapshot(sessionId)
      .then((snapshot) => {
        if (!disposed) {
          setActivity({ status: snapshot.status, needsApproval: snapshot.pendingPermission !== null });
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId]);

  return activity;
}

/** How many derived artifacts of this chat failed, so the Artifacts button can say so. */
export function useFailedArtifacts(sessionId: SessionId | null): number {
  const [failed, setFailed] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!sessionId) {
      setFailed(0);
      return;
    }
    let cancelled = false;
    artifactsList(sessionId)
      .then((items) => {
        if (!cancelled) {
          setFailed(items.filter((item) => item.status === "failed").length);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId, tick]);

  useInsightEvents((event) => {
    if (event.type === "artifact" && event.sessionId === sessionId) {
      setTick((value) => value + 1);
    }
  });

  return failed;
}
