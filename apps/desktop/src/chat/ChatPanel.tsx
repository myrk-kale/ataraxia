import { Button } from "@heroui/react";
import { useEffect, useReducer, useState, type KeyboardEvent } from "react";
import {
  agentCancel,
  agentGetSnapshot,
  agentPrompt,
  agentResolvePermission,
  agentStartSession,
  chatReducer,
  initialChatState,
  listenAgentEvents,
} from "../lib/agent";
import type { ChatSession } from "../lib/workspace";
import { PermissionDialog } from "./PermissionDialog";
import { ToolCard } from "./ToolCard";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ChatPanel({ session }: { session: ChatSession }) {
  const sessionId = session.id;
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    async function connect() {
      unlisten = await listenAgentEvents((event) => {
        if (event.sessionId === sessionId) {
          dispatch({ type: "event", event });
        }
      });
      if (disposed) {
        unlisten();
        return;
      }
      try {
        await agentStartSession(sessionId);
        const snapshot = await agentGetSnapshot(sessionId);
        if (!disposed) {
          dispatch({ type: "loaded", snapshot });
        }
      } catch (err) {
        if (!disposed) {
          dispatch({ type: "failed", message: errorText(err) });
        }
      }
    }
    void connect();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId]);

  const busy = state.status === "working" || state.status === "waiting-permission";
  const canSend = state.loaded && !busy && draft.trim().length > 0;

  async function send() {
    const text = draft.trim();
    if (!text || busy) {
      return;
    }
    setDraft("");
    try {
      await agentPrompt(sessionId, text);
    } catch (err) {
      dispatch({ type: "failed", message: errorText(err) });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  async function resolve(allow: boolean) {
    const pending = state.pending;
    if (!pending) {
      return;
    }
    try {
      await agentResolvePermission(sessionId, pending.requestId, allow);
    } catch (err) {
      dispatch({ type: "failed", message: errorText(err) });
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {state.items.length === 0 && state.loaded ? (
            <p className="py-16 text-center text-sm text-foreground/50">
              {session.title} · {session.provider}. Send a message to start.
            </p>
          ) : null}
          {state.items.map((item) =>
            item.kind === "tool" ? (
              <ToolCard key={item.callId} tool={item} />
            ) : item.role === "user" ? (
              <div
                key={item.id}
                className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl bg-foreground/10 px-4 py-2 text-sm"
              >
                {item.text}
              </div>
            ) : (
              <div
                key={item.id}
                className="whitespace-pre-wrap text-sm leading-6"
              >
                {item.text}
              </div>
            ),
          )}
          {busy ? (
            <p className="text-xs text-foreground/50" role="status">
              {state.status === "waiting-permission"
                ? "Waiting for your approval…"
                : "Working…"}
            </p>
          ) : null}
        </div>
      </div>

      {state.error ? (
        <div
          role="alert"
          className="mx-6 mb-2 flex items-center justify-between rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
        >
          <span className="min-w-0 truncate">{state.error}</span>
          <button
            type="button"
            className="ml-3 text-xs underline"
            onClick={() => dispatch({ type: "dismissError" })}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <form
        className="border-t border-foreground/10 px-6 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            aria-label="Message"
            className="max-h-40 min-h-10 flex-1 resize-none rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
            disabled={!state.loaded}
            placeholder="Message the agent…"
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <Button
              variant="secondary"
              onPress={() => {
                void agentCancel(sessionId).catch((err: unknown) =>
                  dispatch({ type: "failed", message: errorText(err) }),
                );
              }}
            >
              Stop
            </Button>
          ) : (
            <Button type="submit" variant="primary" isDisabled={!canSend}>
              Send
            </Button>
          )}
        </div>
      </form>

      <PermissionDialog
        pending={state.pending}
        onResolve={(allow) => {
          void resolve(allow);
        }}
      />
    </section>
  );
}
