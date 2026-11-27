import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listenAgentEvents } from "../lib/agent";
import type { SessionId, SessionStatus } from "../lib/workspace";

/** What the companion shows, by how much it matters to the person: the same order Codex's pet uses. */
export type PetState = "idle" | "running" | "needs-input" | "ready" | "blocked";

/** What is known of one chat. */
export type ChatActivity = {
  status: SessionStatus | null;
  /** Blocked until the person approves, denies or answers. */
  needsInput: boolean;
  /** A turn finished well and the person has not looked at the chat since. */
  unread: boolean;
  /** The last turn ended with an error the person has not looked at. */
  failed: boolean;
};

export const QUIET: ChatActivity = { status: null, needsInput: false, unread: false, failed: false };

export type PetSummary = {
  state: PetState;
  /** The chat that decides the state (the first of the ones that share it). */
  sessionId: SessionId | null;
  title: string;
  /** How many chats are in this state. */
  count: number;
  /** One line to say it. */
  text: string;
};

const IDLE: PetSummary = { state: "idle", sessionId: null, title: "", count: 0, text: "" };

function stateOf(chat: ChatActivity): PetState {
  if (chat.needsInput || chat.status === "waiting-permission") return "needs-input";
  if (chat.failed || chat.status === "failed") return "blocked";
  if (chat.unread) return "ready";
  if (chat.status === "working" || chat.status === "starting") return "running";
  return "idle";
}

const ORDER: PetState[] = ["needs-input", "blocked", "ready", "running"];

/** The one state to show for every chat there is: what needs the person first, then what failed, finished, or is working. */
export function summarize(chats: ReadonlyMap<SessionId, ChatActivity>, titles: ReadonlyMap<SessionId, string>): PetSummary {
  for (const state of ORDER) {
    const hits = [...chats.entries()].filter(([id, chat]) => titles.has(id) && stateOf(chat) === state);
    if (hits.length === 0) continue;
    const [sessionId] = hits[0]!;
    const title = titles.get(sessionId) ?? "";
    const others = hits.length - 1;
    const more = others > 0 ? ` and ${others} more` : "";
    const text =
      state === "needs-input" ? `Needs you: ${title}${more}`
      : state === "blocked" ? `Stopped with an error: ${title}${more}`
      : state === "ready" ? `Done: ${title}${more}`
      : hits.length > 1 ? `Working on ${hits.length} chats`
      : `Working: ${title}`;
    return { state, sessionId, title, count: hits.length, text };
  }
  return IDLE;
}

/** What one event of an agent does to what is known of its chat. */
export function applyEvent(now: ChatActivity, event: { type: string; status?: SessionStatus; ok?: boolean }): ChatActivity {
  switch (event.type) {
    case "status":
      // New work starts clean: what was unread or failed is old news.
      return event.status === "working"
        ? { ...now, status: event.status, needsInput: false, unread: false, failed: false }
        : { ...now, status: event.status ?? now.status, failed: now.failed || event.status === "failed" };
    case "permission":
      return { ...now, needsInput: true };
    case "turnDone":
      return { ...now, needsInput: false, unread: event.ok !== false ? true : now.unread, failed: event.ok === false ? true : now.failed };
    case "error":
      return { ...now, needsInput: false, failed: true };
    default:
      return now;
  }
}

/**
 * What the agents of every chat are doing, as one state for the companion. A chat the person is
 * looking at is never "unread" or "failed": they are looking at it.
 */
export function useCompanionActivity(
  chats: readonly { id: SessionId; title: string }[],
  viewing: SessionId | null,
): { summary: PetSummary; acknowledge: (id: SessionId) => void } {
  const [known, setKnown] = useState<ReadonlyMap<SessionId, ChatActivity>>(new Map());
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenAgentEvents((event) => {
      if (event.type === "usage" || !("sessionId" in event)) return;
      const id = event.sessionId;
      setKnown((all) => {
        const next = new Map(all);
        let updated = applyEvent(all.get(id) ?? QUIET, event as { type: string; status?: SessionStatus; ok?: boolean });
        if (id === viewingRef.current) {
          updated = { ...updated, unread: false, failed: false };
        }
        next.set(id, updated);
        return next;
      });
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Opening a chat is looking at it.
  useEffect(() => {
    if (!viewing) return;
    setKnown((all) => {
      const chat = all.get(viewing);
      if (!chat || (!chat.unread && !chat.failed)) return all;
      return new Map(all).set(viewing, { ...chat, unread: false, failed: false });
    });
  }, [viewing]);

  const acknowledge = useCallback((id: SessionId) => {
    setKnown((all) => {
      const chat = all.get(id);
      if (!chat) return all;
      return new Map(all).set(id, { ...chat, unread: false, failed: false });
    });
  }, []);

  const titles = useMemo(() => new Map(chats.map((chat) => [chat.id, chat.title])), [chats]);
  const summary = useMemo(() => summarize(known, titles), [known, titles]);
  return { summary, acknowledge };
}
