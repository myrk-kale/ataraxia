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
  agentGetOptions,
  agentGetSnapshot,
  agentMessageSubagent,
  agentPrompt,
  agentResolvePermission,
  agentStartSession,
  chatReducer,
  initialChatState,
  listenAgentEvents,
  PROVIDER_LABELS,
  type ChatItem,
  type ProviderDescriptor,
  type SessionOptions,
} from "../lib/agent";
import type { ChatSession } from "../lib/workspace";
import { play } from "../app/sound/sound";
import { toBlocks } from "./blocks";
import { parseBtwReport } from "./btwReport";
import { Hero } from "./Hero";
import { ProviderMark } from "./ProviderMark";
import { SessionSettings } from "./SessionSettings";
import { StatusDot } from "./StatusDot";
import { SubagentBar } from "./SubagentBar";
import { Markdown } from "./Markdown";
import { PermissionDialog } from "./PermissionDialog";
import { ToolCard } from "./ToolCard";

const STICK_THRESHOLD_PX = 80;
const MAX_COMPOSER_PX = 160;

const TRUNK_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

/** Starting points that name the repository and branch the chat is about. */
export function suggestionsFor(contextLabel: string | null): string[] {
  const [repository, branch] = (contextLabel ?? "").split(" · ");
  const onFeature = Boolean(branch) && !TRUNK_BRANCHES.has(branch ?? "");
  return [
    onFeature ? `Explain what changed on ${branch} and why` : `Give me a tour of ${repository || "this repository"}`,
    "Find TODO and FIXME comments and group them by area",
    onFeature ? `Review ${branch} for bugs before I merge` : "Summarize the most recent commits",
  ];
}

/** What the conversation with the chat's own agent is called, next to its subagents. */
const MAIN_AGENT = "main";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ChatPanel({
  session,
  provider,
  contextLabel,
  bare = false,
  onSessionChange,
}: {
  session: ChatSession;
  provider: ProviderDescriptor | null;
  contextLabel: string | null;
  /** No agent mark or name beside the composer. */
  bare?: boolean;
  onSessionChange: (session: ChatSession) => void;
}) {
  const sessionId = session.id;
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const [options, setOptions] = useState<SessionOptions | null>(null);
  // The subagent whose conversation is on screen; null shows the main conversation.
  const [view, setView] = useState<string | null>(null);
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

  async function loadOptions() {
    try {
      setOptions(await agentGetOptions(sessionId));
    } catch {
      // Options are a convenience; the pickers fall back to the provider's presets.
      setOptions(null);
    }
  }

  useEffect(() => {
    if (state.loaded) {
      void loadOptions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.loaded, sessionId]);

  // Switching the harness restarts the agent underneath this chat: reload what it shows.
  const shownProvider = useRef(session.provider);
  useEffect(() => {
    if (shownProvider.current === session.provider) {
      return;
    }
    shownProvider.current = session.provider;
    setView(null);
    setOptions(null);
    void (async () => {
      try {
        dispatch({ type: "loaded", snapshot: await agentGetSnapshot(sessionId) });
        await loadOptions();
      } catch (err) {
        dispatch({ type: "failed", message: errorText(err) });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.provider]);

  // The agent asking for approval is heard as well as seen, once per request.
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    const id = state.pending?.requestId ?? null;
    if (id && askedFor.current !== id) {
      play("alert");
    }
    askedFor.current = id;
  }, [state.pending]);

  const activeSubagent = state.subagents.find((item) => item.id === view) ?? null;
  const canWrite = activeSubagent === null || provider?.settings.subagent_messages === true;

  // Follow the stream while the reader is at the bottom; leave them alone once they scroll up.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [state.items, state.status, state.pending, state.loaded, activeSubagent]);

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
      if (activeSubagent) {
        await agentMessageSubagent(sessionId, activeSubagent.id, text);
      } else {
        await agentPrompt(sessionId, text);
      }
    } catch (err) {
      dispatch({ type: "failed", message: errorText(err) });
    }
  }

  async function configure(model: string | null, effort: string | null, agent: string | null) {
    try {
      onSessionChange(await agentConfigureSession(sessionId, model, effort, agent));
      // Providers that read these at launch restart the agent; reload to show the divider.
      dispatch({ type: "loaded", snapshot: await agentGetSnapshot(sessionId) });
      await loadOptions();
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
    if (event.key !== "Escape") {
      return;
    }
    if (view !== null) {
      event.preventDefault();
      setView(null);
    } else if (busy) {
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

  const providerLabel = PROVIDER_LABELS[session.provider] ?? session.provider;

  // The divider sits before the first item produced by the running agent process.
  function renderItems(items: ChatItem[], restoredSplit: number) {
    const blocks = toBlocks(items, restoredSplit);
    let seen = 0;
    return blocks.flatMap((block) => {
      const count = block.kind === "agent" ? block.items.length : 1;
      const startsAfterRestore = restoredSplit > 0 && seen === restoredSplit;
      seen += count;

      const report = block.kind === "user" ? parseBtwReport(block.item.text) : null;
      const node =
        block.kind === "user" && report ? (
          <section
            key={block.key}
            aria-label="BTW report"
            className="flex max-w-[680px] min-w-0 flex-col gap-3 rounded-cg-lg border border-cg-line px-5 py-4"
          >
            <h4 className="text-small font-semibold text-cg-muted-strong">BTW finished</h4>
            {report.map((entry, index) => (
              <div key={`${index}:${entry.asked}`} className="flex min-w-0 flex-col gap-1.5">
                <p className="text-ui font-medium break-words text-cg-ink [overflow-wrap:anywhere]">{entry.asked}</p>
                {entry.summary ? (
                  <div className="min-w-0 text-body leading-[1.7] break-words [overflow-wrap:anywhere]">
                    <Markdown text={entry.summary} />
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        ) : block.kind === "user" ? (
          <div
            key={block.key}
            className="max-w-[min(80%,600px)] min-w-0 self-end rounded-cg-lg bg-cg-bubble px-5.5 py-4.5 text-body leading-[1.7] break-words whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {block.item.text}
          </div>
        ) : (
          <div key={block.key} className="flex max-w-[680px] flex-col gap-3">
            {block.items.map((item) =>
              item.kind === "tool" ? (
                <ToolCard key={item.callId} tool={item} />
              ) : (
                <div key={item.id} className="min-w-0 text-body leading-[1.7] break-words [overflow-wrap:anywhere]">
                  <Markdown text={item.text} />
                </div>
              ),
            )}
          </div>
        );
      return startsAfterRestore ? [restoredNotice, node] : [node];
    });
  }

  const rendered = renderItems(state.items, state.restoredCount > 0 ? state.restoredCount : -1);
  const subagentRendered = activeSubagent ? renderItems(activeSubagent.items, -1) : [];

  const emptyChat = state.loaded && state.items.length === 0 && !activeSubagent;

  return (
    <section className="cg-chat flex h-full min-h-0 flex-col" onKeyDown={onPanelKeyDown}>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto" onScroll={onScroll}>
          <div
            className={`mx-auto flex max-w-[780px] flex-col gap-9.5 px-8 ${
              emptyChat ? "min-h-full py-6" : "pt-10 pb-20"
            }`}
          >
            {activeSubagent ? (
              <>
                <div className="flex items-center gap-2 text-small text-cg-muted">
                  <span className="text-small font-semibold">
                    Subagent
                  </span>
                  <span aria-hidden="true">·</span>
                  <strong className="truncate font-semibold text-cg-ink">
                    {activeSubagent.title}
                  </strong>
                  <span aria-hidden="true">·</span>
                  <span>{activeSubagent.status === "running" ? "working" : activeSubagent.status}</span>
                </div>
                {subagentRendered.length === 0 ? (
                  <p className="text-small text-cg-muted">
                    {activeSubagent.status === "running"
                      ? "Waiting for this subagent to report…"
                      : "Nothing reported by this subagent."}
                  </p>
                ) : null}
                {subagentRendered}
                {activeSubagent.status === "running" ? (
                  <span aria-label="Subagent working" className="-mt-5 flex gap-1" role="status">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cg-muted/60" />
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cg-muted/60 [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cg-muted/60 [animation-delay:300ms]" />
                  </span>
                ) : null}
              </>
            ) : (
              <>
            {state.loaded && state.items.length > 0 ? (
              <div className="flex items-center gap-2 text-small text-cg-muted">
                <span className="text-small font-semibold">
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
                  {suggestionsFor(contextLabel).map((suggestion) => (
                    <button
                      key={suggestion}
                      className="rounded-cg-md border border-cg-line px-3 py-2 text-small text-cg-muted-strong hover:border-cg-line-strong hover:text-cg-ink"
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
              </>
            )}
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
          className="mx-auto mb-2 flex w-full max-w-[780px] items-center justify-between rounded-cg-md bg-cg-del-bg px-3.5 py-2.5 text-small text-cg-del-fg"
        >
          <span className="min-w-0 break-words">{state.error}</span>
          <button
            className="ml-3 shrink-0 text-small underline"
            type="button"
            onClick={() => dispatch({ type: "dismissError" })}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <SubagentBar
        busy={busy && view !== null}
        mainLabel={MAIN_AGENT}
        provider={session.provider}
        selected={activeSubagent ? activeSubagent.id : null}
        subagents={state.subagents}
        onSelect={(id) => {
          stickRef.current = true;
          setView(id);
        }}
        onStop={cancelTurn}
      />

      <form
        className="mx-auto w-full max-w-[840px] flex-none px-8.5 pt-2.5 pb-6.5"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="cg-field rounded-cg-lg bg-cg-tint px-4 py-3.5">
          <textarea
            ref={composerRef}
            aria-label="Message"
            className="block max-h-40 min-h-[47px] w-full resize-none border-0 bg-transparent text-body text-cg-ink outline-none placeholder:text-cg-muted"
            disabled={!state.loaded || !canWrite}
            placeholder={
              activeSubagent
                ? canWrite
                  ? `Message ${activeSubagent.title}…`
                  : "This provider cannot message a subagent"
                : `Ask ${MAIN_AGENT} to change something…`
            }
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
          />
          <div className="mt-1 flex min-h-[29px] items-center justify-between text-small text-cg-muted">
            <div className="flex min-w-0 items-center gap-2.5">
              {bare ? null : (
                <>
                  <ProviderMark provider={session.provider} size={24} />
                  <span className="truncate text-ui font-semibold text-cg-ink">{MAIN_AGENT}</span>
                </>
              )}
              <StatusDot status={state.status} />
            </div>
            {activeSubagent ? (
              <button
                className="rounded-cg-sm px-2 py-1 text-small text-cg-muted-strong hover:bg-cg-line hover:text-cg-ink"
                type="button"
                onClick={() => setView(null)}
              >
                ← Back to {MAIN_AGENT} (Esc)
              </button>
            ) : (
            <div className="flex flex-none items-center gap-3">
              <SessionSettings
                disabled={busy || !state.loaded}
                disabledReason="Wait for the current turn to finish"
                agent={session.agent}
                effort={session.effort}
                model={session.model}
                options={options}
                provider={provider}
                onChange={(model, effort, agent) => {
                  void configure(model, effort, agent);
                }}
              />
              {busy ? (
                <button
                  aria-label="Stop"
                  className="grid h-[29px] w-[29px] place-items-center rounded-cg-md bg-cg-primary text-cg-on-primary hover:bg-cg-primary-hover"
                  type="button"
                  onClick={cancelTurn}
                >
                  <Square fill="currentColor" size={11} />
                </button>
              ) : null}
            </div>
            )}
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
