import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../lib/useInsightEvents";
import {
  workbenchClear,
  workbenchDirect,
  workbenchJoin,
  workbenchLeave,
  workbenchReply,
  workbenchResolve,
  type EntryView,
} from "../lib/workbench";
import type { ChatSession, Worktree } from "../lib/workspace";
import { Button } from "../ui/Button";
import { Segmented } from "../ui/Overlay";
import { StateMessage } from "../ui/State";
import { AgentRail } from "./AgentRail";
import { Composer } from "./Composer";
import { EmptyBoard } from "./EmptyBoard";
import { Files, sharedRows } from "./Files";
import { KIND_FILTERS, kindCounts, newerThan, summaryText, topicsMarkdown, visibleEntries, type KindFilter } from "./model";
import { NeedsYou } from "./NeedsYou";
import type { EntryActions } from "./parts";
import { Timeline } from "./Timeline";
import { Topics } from "./Topics";
import { useNow, type WorkbenchBoard } from "./useWorkbench";

type Tab = "timeline" | "topics" | "files";

const FILTER_BUTTON =
  "rounded-cg-sm px-2.5 py-1 text-ui text-cg-muted-strong hover:bg-cg-tint aria-pressed:bg-cg-tint aria-pressed:font-semibold aria-pressed:text-cg-ink";

/**
 * The workbench: the board agents working side by side in one workspace share, and the place to
 * follow them. Left, one card per agent (working or not, what it said it is doing, what it holds,
 * how much it changed). Above the stream, what needs the developer. In the stream, what was
 * decided, held, asked and finished; beside it, the decisions by topic and who touches which file.
 * Below it, the developer's word to them.
 */
export function WorkbenchSpace({
  board,
  workspaceId,
  workspaceName,
  chats,
  worktrees,
  visible,
  onOpenChat,
  onOpenFile,
  onError,
}: {
  /** The board, read by the shell so the nav can tell when something waits for the developer. */
  board: WorkbenchBoard;
  workspaceId: string | null;
  workspaceName: string;
  /** The chats of this workspace, the ones that could join the board among them. */
  chats: readonly ChatSession[];
  worktrees: readonly Worktree[];
  visible: boolean;
  onOpenChat: (sessionId: string) => void;
  onOpenFile: (path: string, line: number | null, endLine: number | null) => void;
  onError: (message: string) => void;
}) {
  const { view, state, stale, reload } = board;
  const now = useNow(visible);
  const [tab, setTab] = useState<Tab>("timeline");
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [sharedOnly, setSharedOnly] = useState(false);
  const [seenSeq, setSeenSeq] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [copied, setCopied] = useState(false);
  const feed = useRef<HTMLDivElement>(null);

  // Another workspace is another board.
  useEffect(() => {
    setSeenSeq(null);
    setAgent(null);
    setQuery("");
    setKind("all");
    setClearing(false);
  }, [workspaceId]);
  // Nothing on a board that has just been read is new.
  useEffect(() => {
    if (view && seenSeq === null) {
      setSeenSeq(view.latestSeq);
    }
  }, [view, seenSeq]);
  // Leaving the screen is reading it, as it stood then: what is posted while the developer is away
  // is new when they come back.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (wasVisible.current && !visible && view) {
      setSeenSeq(view.latestSeq);
    }
    wasVisible.current = visible;
  }, [visible, view]);
  // An agent that left the board cannot be the one the board is narrowed to.
  useEffect(() => {
    if (agent && view && !view.members.some((member) => member.sessionId === agent)) {
      setAgent(null);
    }
  }, [agent, view]);

  const entries = view?.entries;
  const byId = useMemo(() => new Map<string, EntryView>((entries ?? []).map((entry) => [entry.id, entry])), [entries]);
  const shown = useMemo(() => visibleEntries(entries ?? [], { kind, query, agent, history }), [entries, kind, query, agent, history]);
  const counts = useMemo(() => kindCounts(entries ?? [], history), [entries, history]);
  const members = view?.members ?? [];
  const newCount = entries && seenSeq !== null ? newerThan(entries, seenSeq) : 0;
  const sharedCount = view ? sharedRows(view.files).length : 0;
  const settledCount = view ? view.topics.filter((topic) => topic.standing !== null).length : 0;
  const agentTitle = members.find((member) => member.sessionId === agent)?.title ?? null;

  /** Does something and reads the board again; says why when it could not. */
  async function act(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      await reload();
      // What was just done is the newest thing on the board: bring it into view.
      feed.current?.scrollTo?.({ top: 0 });
      return true;
    } catch (err) {
      onError(errorText(err));
      return false;
    }
  }
  /** The same, for what somebody typed: it throws so the field keeps their words. */
  async function strict(action: () => Promise<unknown>) {
    if (!(await act(action))) {
      throw new Error("not done");
    }
  }

  const actions: EntryActions = {
    onOpenFile,
    onReply: (entryId, text) => strict(() => workbenchReply(entryId, text)),
    onResolve: async (entryId, resolution) => {
      await act(() => workbenchResolve(entryId, resolution));
    },
    onPickTopic: (topic) => {
      setTab("timeline");
      setKind("all");
      setQuery(topic);
    },
  };

  async function copyDecisions() {
    if (!view) {
      return;
    }
    try {
      await navigator.clipboard.writeText(topicsMarkdown(view.topics, workspaceName));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      onError("The clipboard is not available.");
    }
  }

  if (!workspaceId) {
    return <StateMessage text="Open a workspace first: the workbench is shared by its chats." />;
  }
  if (!view) {
    return state.kind === "failed" ? (
      <StateMessage text={`The workbench did not open: ${state.message}`} tone="failed">
        <Button variant="secondary" onClick={() => void reload()}>
          Try again
        </Button>
      </StateMessage>
    ) : (
      <StateMessage text="Opening the workbench…" tone="loading" />
    );
  }
  if (members.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <EmptyBoard chats={chats} worktrees={worktrees} onJoin={(id) => void act(() => workbenchJoin(id))} />
      </div>
    );
  }

  const filtered = kind !== "all" || query.trim() !== "" || agent !== null;
  return (
    <div className="flex h-full min-h-0 flex-col bg-cg-panel">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-cg-line px-6 py-4">
        <h1 className="text-title font-semibold tracking-[-0.3px] text-cg-ink">Workbench</h1>
        <span className="text-ui text-cg-muted">{workspaceName}</span>
        <p className="text-ui text-cg-muted-strong">{summaryText(view)}</p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {stale ? (
            <span className="text-small text-cg-amber-text" role="alert">
              Could not refresh: {stale}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-small text-cg-muted" role="status" title="The board is read again every few seconds while you look at it.">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-cg-control" />
              Live
            </span>
          )}
          <Button disabled={settledCount === 0} size="sm" title="Copy what the agents decided, as Markdown" variant="quiet" onClick={() => void copyDecisions()}>
            {copied ? "Copied" : "Copy decisions"}
          </Button>
          {clearing ? (
            <>
              <span className="text-small text-cg-muted-strong">Delete every entry?</span>
              <Button autoFocus size="sm" variant="quiet" onClick={() => setClearing(false)}>
                Keep
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  setClearing(false);
                  void act(() => workbenchClear(workspaceId));
                }}
              >
                Clear the board
              </Button>
            </>
          ) : (
            <Button disabled={view.entries.length === 0} size="sm" title="Start a fresh run: the chats stay on the board" variant="quiet" onClick={() => setClearing(true)}>
              Clear board
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <AgentRail
          chats={chats}
          members={members}
          selected={agent}
          worktrees={worktrees}
          onJoin={(id) => void act(() => workbenchJoin(id))}
          onLeave={(id) => void act(() => workbenchLeave(id))}
          onOpenChat={onOpenChat}
          onSelect={setAgent}
        />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <NeedsYou
            byId={byId}
            files={view.files}
            members={members}
            needs={view.needsYou}
            topics={view.topics}
            onAnswer={(entryId, text) => strict(() => workbenchReply(entryId, text))}
            onOpenChat={onOpenChat}
            onResolve={actions.onResolve}
            onTell={(sessionId, text) => strict(() => workbenchDirect(workspaceId, text, sessionId, null))}
          />

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-cg-line px-6 py-2.5">
            <Segmented
              label="Board view"
              options={[
                { id: "timeline", label: "Timeline" },
                { id: "topics", label: view.topics.length > 0 ? `Topics ${view.topics.length}` : "Topics" },
                { id: "files", label: view.files.length > 0 ? `Files ${view.files.length}` : "Files" },
              ]}
              value={tab}
              onChange={setTab}
            />
            {tab === "timeline" ? (
              <>
                <div aria-label="Kind of entry" className="flex flex-wrap items-center gap-0.5" role="group">
                  {KIND_FILTERS.map((filter) => (
                    <button key={filter.id} aria-pressed={kind === filter.id} className={FILTER_BUTTON} type="button" onClick={() => setKind(filter.id)}>
                      {filter.label} <span className="text-cg-muted">{counts[filter.id]}</span>
                    </button>
                  ))}
                </div>
                <button aria-pressed={history} className={FILTER_BUTTON} title="Also show claims that ran out, and what was replaced or set aside" type="button" onClick={() => setHistory((on) => !on)}>
                  History
                </button>
                <label className="relative ml-auto flex items-center">
                  <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 text-cg-muted" size={13} />
                  <input
                    aria-label="Search the board"
                    className="w-48 rounded-cg-md border border-cg-line-strong bg-cg-panel py-1 pr-2.5 pl-8 text-ui text-cg-ink placeholder:text-cg-muted focus:border-cg-ink"
                    placeholder="Search"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
              </>
            ) : null}
            {tab === "files" ? (
              <button aria-pressed={sharedOnly} className={FILTER_BUTTON} type="button" onClick={() => setSharedOnly((on) => !on)}>
                Only shared files <span className="text-cg-muted">{sharedCount}</span>
              </button>
            ) : null}
            {agentTitle ? (
              <span className="inline-flex items-center gap-1 rounded-cg-sm border border-cg-line-strong bg-cg-tint py-0.5 pr-1 pl-2 text-small text-cg-ink">
                Only {agentTitle}
                <Button aria-label="Show every agent again" variant="icon" onClick={() => setAgent(null)}>
                  <X aria-hidden="true" size={12} />
                </Button>
              </span>
            ) : null}
            {tab === "timeline" && newCount > 0 ? (
              <button className="rounded-cg-sm px-2.5 py-1 text-ui font-medium text-cg-ink hover:bg-cg-tint" type="button" onClick={() => setSeenSeq(view.latestSeq)}>
                {newCount} new · Mark as read
              </button>
            ) : null}
          </div>
          <p aria-live="polite" className="sr-only">
            {newCount > 0 ? `${newCount} new on the workbench` : ""}
          </p>

          <div ref={feed} className="min-h-0 flex-1 overflow-y-auto">
            {tab === "timeline" ? (
              shown.length === 0 ? (
                <div className="mx-auto flex max-w-[560px] flex-col items-center gap-3 px-6 py-10 text-center">
                  <p className="text-ui leading-6 text-cg-muted">
                    {view.entries.length === 0
                      ? "Nothing posted yet. Agents post here when they decide, hold or finish something. What they change in their files is already on the Files tab."
                      : "Nothing matches. Try another kind, another search, or turn History on."}
                  </p>
                  {filtered ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setKind("all");
                        setQuery("");
                        setAgent(null);
                      }}
                    >
                      Clear the filters
                    </Button>
                  ) : null}
                </div>
              ) : (
                <Timeline actions={actions} byId={byId} entries={shown} members={members} now={now} seenSeq={seenSeq ?? view.latestSeq} />
              )
            ) : null}
            {tab === "topics" ? (
              <Topics
                actions={actions}
                members={members}
                now={now}
                topics={agent ? view.topics.filter((topic) => [topic.standing, ...topic.proposals, ...topic.heldBy, ...topic.openQuestions].some((entry) => entry?.author === agent)) : view.topics}
              />
            ) : null}
            {tab === "files" ? (
              <Files
                members={members}
                rows={(sharedOnly ? sharedRows(view.files) : view.files).filter((row) => agent === null || row.touchers.some((toucher) => toucher.sessionId === agent))}
              />
            ) : null}
          </div>

          <Composer
            members={members}
            to={agent}
            onSend={(text, to, topic) => strict(() => workbenchDirect(workspaceId, text, to, topic))}
          />
        </main>
      </div>
    </div>
  );
}
