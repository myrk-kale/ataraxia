import { Bot, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { browserClearHistory, browserHistory, browserOpen, type BrowserHistoryEntry } from "../lib/browser";
import { Button } from "../ui/Button";

export function BrowserHistoryPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [entries, setEntries] = useState<BrowserHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let stopped = false;
    search.current?.focus();
    setError(null);
    browserHistory(workspaceId).then(
      (items) => { if (!stopped) setEntries(items); },
      (reason: unknown) => { if (!stopped) setError(String(reason)); },
    );
    return () => { stopped = true; };
  }, [workspaceId, retry]);

  async function clear(): Promise<void> {
    setClearing(true);
    try {
      await browserClearHistory(workspaceId);
      setEntries([]);
      setConfirmClear(false);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setClearing(false);
    }
  }

  async function open(url: string): Promise<void> {
    try {
      await browserOpen(url);
      onClose();
    } catch (reason) {
      setError(String(reason));
    }
  }

  const needle = query.trim().toLowerCase();
  const filtered = entries?.filter((entry) => `${entry.title} ${entry.url}`.toLowerCase().includes(needle));

  return (
    <section aria-label="Workspace browsing history" className="absolute inset-0 z-20 flex min-h-0 flex-col bg-cg-panel" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header className="flex flex-none items-center justify-between gap-3 border-b border-cg-line px-4 py-2">
        <div>
          <h2 className="text-body font-medium text-cg-ink">History</h2>
          <p className="text-small text-cg-muted-strong">The 500 most recent pages in this workspace, including agent tabs.</p>
        </div>
        <Button aria-label="Close history" variant="icon" onClick={onClose}><X aria-hidden="true" size={15} /></Button>
      </header>
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-cg-line p-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-cg-md border border-cg-line-strong px-3 py-2 focus-within:border-cg-ink">
          <Search aria-hidden="true" size={14} className="text-cg-muted-strong" />
          <input aria-label="Search history" ref={search} className="min-w-0 flex-1 bg-transparent text-ui text-cg-ink outline-none placeholder:text-cg-muted" placeholder="Search title or address" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <Button size="sm" variant="quiet" disabled={!entries?.length || clearing} onClick={() => setConfirmClear(true)}>Clear history</Button>
      </div>
      {confirmClear ? (
        <div className="flex flex-none flex-wrap items-center gap-2 border-b border-cg-line px-4 py-3 text-small text-cg-ink">
          <p className="flex-1">Clear this workspace's history? Open tabs and site data will stay.</p>
          <Button size="sm" variant="quiet" disabled={clearing} onClick={() => setConfirmClear(false)}>Cancel</Button>
          <Button size="sm" variant="secondary" disabled={clearing} onClick={clear}>{clearing ? "Clearing…" : "Confirm clear"}</Button>
        </div>
      ) : null}
      {error ? <div role="alert" className="flex items-center gap-2 px-4 py-3 text-small text-cg-red"><p className="flex-1">Could not update history: {error}</p>{!entries ? <Button size="sm" variant="quiet" onClick={() => setRetry((value) => value + 1)}>Try again</Button> : null}</div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!entries && !error ? <p role="status" className="p-4 text-small text-cg-muted-strong">Loading history…</p> : null}
        {entries?.length === 0 ? <p className="p-4 text-small text-cg-muted-strong">No pages visited in this workspace yet. Open a website to start its history.</p> : entries && filtered?.length === 0 ? <p className="p-4 text-small text-cg-muted-strong">No pages match this search.</p> : null}
        <ul>
          {filtered?.map((entry) => (
            <li key={entry.url}>
              <button className="flex w-full cursor-pointer items-center gap-3 rounded-cg-sm px-3 py-2 text-left hover:bg-cg-tint focus-visible:outline-2 focus-visible:outline-cg-accent" type="button" onClick={() => void open(entry.url)} title={`Open in a new tab: ${entry.url}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui text-cg-ink">{entry.title || entry.url}</span>
                  <span className="block truncate text-small text-cg-muted-strong">{entry.url}</span>
                </span>
                {entry.profile === "agent" ? <Bot aria-label="Visited by an agent" size={14} className="flex-none text-cg-muted-strong" /> : null}
                <time dateTime={entry.visitedAt} className="flex-none text-small text-cg-muted-strong">{new Date(entry.visitedAt).toLocaleString()}</time>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
