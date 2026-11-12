import { Button } from "@heroui/react";
import { ArrowDown } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  agentCancel,
  agentGetSnapshot,
  agentPrompt,
  agentResolvePermission,
  agentStartSession,
  chatReducer,
  initialChatState,
  listenAgentEvents,
  PROVIDER_LABELS,
} from "../lib/agent";
import type { ChatSession, SessionStatus } from "../lib/workspace";
import { Markdown } from "./Markdown";
import { PermissionDialog } from "./PermissionDialog";
import { ToolCard } from "./ToolCard";

const STICK_THRESHOLD_PX = 80;
const MAX_COMPOSER_PX = 160;

const SUGGESTIONS = [
  "Give me a tour of this repository",
  "Find TODO and FIXME comments",
  "Summarize the most recent commits",
];

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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function StatusDot({ status }: { status: SessionStatus }) {
  const color =
    status === "working" || status === "starting"
      ? "bg-amber-500 animate-pulse"
      : status === "waiting-permission"
        ? "bg-sky-500 animate-pulse"
        : status === "failed"
          ? "bg-red-500"
          : status === "ready"
            ? "bg-emerald-500"
            : "bg-foreground/30";
  return <span aria-hidden="true" className={`h-2 w-2 rounded-full ${color}`} />;
}

export function ChatPanel({ session }: { session: ChatSession }) {
  const sessionId = session.id;
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);

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

  // Follow the stream while the reader is at the bottom; leave them alone once they scroll up.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [state.items, state.status, state.pending, state.loaded]);

  // Grow the composer with its content up to a cap.
  useLayoutEffect(() => {
    const element = composerRef.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, MAX_COMPOSER_PX)}px`;
    }
  }, [draft]);

  const busy = state.status === "working" || state.status === "waiting-permission";
  const canSend = state.loaded && !busy && draft.trim().length > 0;

  function onScroll() {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const near = distance < STICK_THRESHOLD_PX;
    stickRef.current = near;
    setAtBottom(near);
  }

  function jumpToLatest() {
    const element = scrollRef.current;
    if (element) {
      stickRef.current = true;
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) {
      return;
    }
    setDraft("");
    stickRef.current = true;
    try {
      await agentPrompt(sessionId, text);
    } catch (err) {
      dispatch({ type: "failed", message: errorText(err) });
    }
  }

  function cancelTurn() {
    void agentCancel(sessionId).catch((err: unknown) =>
      dispatch({ type: "failed", message: errorText(err) }),
    );
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && busy) {
      event.preventDefault();
      cancelTurn();
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

  const restoredDividerAfter = state.restoredCount > 0 ? state.restoredCount - 1 : -1;
  const restoredNotice = (
    <div
      key="restored"
      className="my-1 flex items-center gap-3 text-xs text-foreground/45"
      role="note"
    >
      <span className="h-px flex-1 bg-foreground/15" />
      <span>Earlier messages are shown for reference; the agent starts fresh.</span>
      <span className="h-px flex-1 bg-foreground/15" />
    </div>
  );

  return (
    <section className="flex h-full min-h-0 flex-col" onKeyDown={onPanelKeyDown}>
      <header className="flex items-center gap-2 border-b border-foreground/10 px-6 py-2 text-xs text-foreground/60">
        <span className="truncate font-medium text-foreground/80">{session.title}</span>
        <span className="rounded-full bg-foreground/10 px-2 py-0.5">
          {PROVIDER_LABELS[session.provider]}
        </span>
        <span className="ml-auto flex items-center gap-1.5" role="status">
          <StatusDot status={state.status} />
          {STATUS_LABEL[state.status]}
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto px-6 py-4"
          onScroll={onScroll}
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {!state.loaded ? (
              <p className="py-16 text-center text-sm text-foreground/50">
                Starting {PROVIDER_LABELS[session.provider]}…
              </p>
            ) : null}

            {state.loaded && state.items.length === 0 ? (
              <div className="flex flex-col items-center gap-4 py-16 text-center">
                <p className="text-sm text-foreground/60">
                  Ask {PROVIDER_LABELS[session.provider]} about this worktree.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      className="rounded-full border border-foreground/15 px-3 py-1 text-xs hover:bg-foreground/5"
                      type="button"
                      onClick={() => {
                        setDraft(suggestion);
                        composerRef.current?.focus();
                      }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {state.items.flatMap((item, index) => {
              const node =
                item.kind === "tool" ? (
                  <ToolCard key={item.callId} tool={item} />
                ) : item.role === "user" ? (
                  <div
                    key={item.id}
                    className="max-w-[85%] self-end rounded-2xl bg-foreground/10 px-4 py-2 text-sm whitespace-pre-wrap"
                  >
                    {item.text}
                  </div>
                ) : (
                  <div key={item.id} className="text-sm leading-6">
                    <Markdown text={item.text} />
                  </div>
                );
              return index === restoredDividerAfter ? [node, restoredNotice] : [node];
            })}

            {busy ? (
              <p className="flex items-center gap-2 text-xs text-foreground/50">
                <span className="flex gap-1" aria-hidden="true">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-foreground/40" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-foreground/40 [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-foreground/40 [animation-delay:300ms]" />
                </span>
                {state.status === "waiting-permission"
                  ? "Waiting for your approval"
                  : "Working — press Esc to stop"}
              </p>
            ) : null}
          </div>
        </div>

        {!atBottom ? (
          <button
            aria-label="Jump to latest"
            className="absolute right-6 bottom-3 flex items-center gap-1 rounded-full border border-foreground/15 bg-background px-3 py-1 text-xs shadow-md hover:bg-foreground/5"
            type="button"
            onClick={jumpToLatest}
          >
            <ArrowDown size={12} />
            Latest
          </button>
        ) : null}
      </div>

      {state.error ? (
        <div
          role="alert"
          className="mx-6 mb-2 flex items-center justify-between rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
        >
          <span className="min-w-0 break-words">{state.error}</span>
          <button
            className="ml-3 shrink-0 text-xs underline"
            type="button"
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
            ref={composerRef}
            aria-label="Message"
            className="max-h-40 min-h-10 flex-1 resize-none rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
            disabled={!state.loaded}
            placeholder="Message the agent — Enter to send, Shift+Enter for a new line"
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
          />
          {busy ? (
            <Button variant="secondary" onPress={cancelTurn}>
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
