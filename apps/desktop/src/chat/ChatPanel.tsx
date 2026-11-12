import { ArrowDown, Square } from "lucide-react";
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
  agentConfigureSession,
  agentGetSnapshot,
  agentPrompt,
  agentResolvePermission,
  agentStartSession,
  chatReducer,
  initialChatState,
  listenAgentEvents,
  PROVIDER_LABELS,
  type ProviderDescriptor,
} from "../lib/agent";
import type { ChatSession } from "../lib/workspace";
import { toBlocks } from "./blocks";
import { Hero } from "./Hero";
import { SessionSettings } from "./SessionSettings";
import { StatusDot } from "./StatusDot";
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ChatPanel({
  session,
  provider,
  contextLabel,
  onSessionChange,
}: {
  session: ChatSession;
  provider: ProviderDescriptor | null;
  contextLabel: string | null;
  onSessionChange: (session: ChatSession) => void;
}) {
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

  async function configure(model: string | null, effort: string | null) {
    try {
      onSessionChange(await agentConfigureSession(sessionId, model, effort));
      // Providers that read these at launch restart the agent; reload to show the divider.
      dispatch({ type: "loaded", snapshot: await agentGetSnapshot(sessionId) });
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

  const restoredNotice = (
    <div
      key="restored"
      className="flex items-center gap-3 text-small text-cg-muted"
      role="note"
    >
      <span className="h-px flex-1 bg-cg-line" />
      <span>Earlier messages are shown for reference; the agent starts fresh.</span>
      <span className="h-px flex-1 bg-cg-line" />
    </div>
  );

  const restoredSplit = state.restoredCount > 0 ? state.restoredCount : -1;
  const blocks = toBlocks(state.items, restoredSplit);
  const providerLabel = PROVIDER_LABELS[session.provider];

  // The divider sits before the first item produced by the running agent process.
  let seen = 0;
  const rendered = blocks.flatMap((block) => {
    const count = block.kind === "agent" ? block.items.length : 1;
    const startsAfterRestore = restoredSplit > 0 && seen === restoredSplit;
    seen += count;

    const node =
      block.kind === "user" ? (
        <div
          key={block.key}
          className="max-w-[min(80%,600px)] self-end rounded-2xl bg-cg-bubble px-[19px] py-[15px] text-body leading-[1.7] whitespace-pre-wrap"
        >
          {block.item.text}
        </div>
      ) : (
        <div key={block.key} className="flex max-w-[680px] flex-col gap-3">
          <div className="flex items-center gap-2 text-ui text-cg-muted">
            <span aria-hidden="true" className="text-cg-accent">
              ✳
            </span>
            <strong className="font-semibold text-cg-ink">{providerLabel}</strong>
          </div>
          {block.items.map((item) =>
            item.kind === "tool" ? (
              <ToolCard key={item.callId} tool={item} />
            ) : (
              <div key={item.id} className="text-body leading-[1.7]">
                <Markdown text={item.text} />
              </div>
            ),
          )}
        </div>
      );
    return startsAfterRestore ? [restoredNotice, node] : [node];
  });

  const emptyChat = state.loaded && state.items.length === 0;

  return (
    <section
      className="cg-page-in flex h-full min-h-0 flex-col"
      onKeyDown={onPanelKeyDown}
    >
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto" onScroll={onScroll}>
          <div
            className={`mx-auto flex max-w-[780px] flex-col gap-[33px] px-8 ${
              emptyChat ? "min-h-full py-6" : "pt-[35px] pb-20"
            }`}
          >
            {state.loaded && state.items.length > 0 ? (
              <div className="flex items-center gap-2 text-small text-cg-muted">
                <span className="text-micro font-bold tracking-[1.15px] uppercase">
                  Coding session
                </span>
                <span aria-hidden="true">·</span>
                <strong className="truncate font-semibold text-cg-ink">{session.title}</strong>
              </div>
            ) : null}

            {!state.loaded ? (
              <p className="py-16 text-center text-small text-cg-muted">
                Starting {providerLabel}…
              </p>
            ) : null}

            {emptyChat ? (
              <Hero contextLabel={contextLabel}>
                <div className="mt-8 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      className="rounded-lg border border-cg-line px-3 py-2 text-small text-cg-muted-strong hover:border-cg-line-strong hover:text-cg-ink"
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
              </Hero>
            ) : null}

            {rendered}

            {busy ? (
              <span
                aria-label={state.status === "waiting-permission" ? "Waiting for approval" : "Working"}
                className="-mt-5 flex gap-1"
                role="status"
              >
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cg-muted/60" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cg-muted/60 [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cg-muted/60 [animation-delay:300ms]" />
              </span>
            ) : null}
          </div>
        </div>

        {!atBottom ? (
          <button
            aria-label="Jump to latest"
            className="absolute right-6 bottom-3 flex items-center gap-1 rounded-full border border-cg-line-strong bg-cg-panel px-3 py-1 text-small text-cg-muted-strong shadow-md hover:text-cg-ink"
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
          className="mx-auto mb-2 flex w-full max-w-[780px] items-center justify-between rounded-[9px] bg-cg-del-bg px-3.5 py-2.5 text-small text-cg-del-fg"
        >
          <span className="min-w-0 break-words">{state.error}</span>
          <button
            className="ml-3 shrink-0 text-micro underline"
            type="button"
            onClick={() => dispatch({ type: "dismissError" })}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <form
        className="mx-auto w-full max-w-[840px] flex-none px-[30px] pt-[9px] pb-[23px]"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="rounded-[14px] bg-cg-tint px-4 py-3.5">
          <textarea
            ref={composerRef}
            aria-label="Message"
            className="block max-h-40 min-h-[47px] w-full resize-none border-0 bg-transparent text-body text-cg-ink outline-none placeholder:text-cg-muted/70"
            disabled={!state.loaded}
            placeholder={`Ask ${providerLabel} to change something…`}
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
          />
          <div className="mt-1 flex min-h-[29px] items-center justify-between text-small text-cg-muted">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                aria-hidden="true"
                className="grid h-6 w-6 flex-none place-items-center rounded-[7px] bg-cg-accent-bg text-[13px] leading-none text-cg-accent"
              >
                ✳
              </span>
              <span className="truncate text-ui font-semibold text-cg-ink">{providerLabel}</span>
              <StatusDot status={state.status} />
            </div>
            <div className="flex flex-none items-center gap-3">
              <SessionSettings
                disabled={busy || !state.loaded}
                disabledReason="Wait for the current turn to finish"
                effort={session.effort}
                model={session.model}
                provider={provider}
                onChange={(model, effort) => {
                  void configure(model, effort);
                }}
              />
              {busy ? (
                <button
                  aria-label="Stop"
                  className="grid h-[29px] w-[29px] place-items-center rounded-lg bg-cg-primary text-cg-on-primary hover:bg-cg-primary-hover"
                  type="button"
                  onClick={cancelTurn}
                >
                  <Square fill="currentColor" size={11} />
                </button>
              ) : null}
            </div>
          </div>
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
