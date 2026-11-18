import { Search, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { globalSearch, SEARCH_KINDS, type SearchKind, type SearchResult } from "../lib/search";
import type { Repository, Workspace } from "../lib/workspace";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Overlay";

type SearchState =
  | { kind: "loading" }
  | { kind: "ready"; results: SearchResult[] }
  | { kind: "failed"; message: string };

const CONTROL = "w-full rounded-cg-md border border-cg-control bg-cg-panel px-2.5 py-1.5 text-ui text-cg-ink focus-visible:outline-2 focus-visible:outline-cg-accent";

export function GlobalSearch({
  workspaces,
  repositories,
  onClose,
  onOpen,
}: {
  workspaces: Workspace[];
  repositories: Repository[];
  onClose: () => void;
  onOpen: (result: SearchResult) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SearchKind | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "loading" });
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const resultsList = useRef<HTMLUListElement>(null);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const visibleRepositories = workspace
    ? repositories.filter((item) => workspace.repository_ids.includes(item.id))
    : repositories;
  const term = query.trim();

  useEffect(() => {
    if (!term) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void globalSearch({ query: term, kind, workspaceId: workspaceId || null, repositoryId: repositoryId || null })
        .then((results) => {
          if (!cancelled) {
            setState({ kind: "ready", results });
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setState({ kind: "failed", message: String(error) });
          }
        });
    }, 90);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [term, kind, workspaceId, repositoryId, retry]);

  const results = term && state.kind === "ready" ? state.results : [];

  function resetResults() {
    setState({ kind: "loading" });
    setOpenError(null);
  }

  async function openResult(result: SearchResult) {
    if (opening) {
      return;
    }
    setOpening(true);
    setOpenError(null);
    try {
      await onOpen(result);
      onClose();
    } catch (error) {
      setOpenError(String(error));
    } finally {
      setOpening(false);
    }
  }

  function onSearchKey(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey ||
        (event.key !== "Enter" && event.key !== "ArrowDown" && event.key !== "ArrowUp")) {
      return;
    }
    const buttons = Array.from(resultsList.current?.querySelectorAll("button") ?? []);
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (event.key === "Enter") {
      const result = results[Math.max(0, index)];
      if (result) {
        event.preventDefault();
        void openResult(result);
      }
      return;
    }
    if (!buttons.length) {
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : -1;
    event.preventDefault();
    if (index === 0 && step === -1) {
      input.current?.focus();
    } else {
      const next = index === -1 && step === -1 ? buttons.length - 1 : Math.min(index + step, buttons.length - 1);
      buttons[next]?.focus();
    }
  }

  return (
    <Dialog isOpen wide placement="top" label="Global search" onClose={onClose}>
      <section className="flex max-h-[75dvh] min-h-0 flex-col overflow-y-auto">
        <div
          role="search"
          className="flex items-center gap-3 border-b border-cg-line px-4 py-3"
        >
          <Search aria-hidden="true" className="shrink-0 text-cg-muted-strong" size={18} />
          <input
            ref={input}
            aria-label="Search Ataraxia"
            autoFocus
            autoComplete="off"
            className="min-w-0 flex-1 rounded-cg-sm bg-transparent px-2 py-2 text-body text-cg-ink focus-visible:outline-2 focus-visible:outline-cg-accent"
            placeholder="Search Ataraxia"
            spellCheck={false}
            type="search"
            value={query}
            onChange={(event) => {
              const value = event.target.value;
              if (value.trim() !== term) {
                resetResults();
              }
              setQuery(value);
            }}
            onKeyDown={onSearchKey}
          />
          <Button aria-label="Close search" variant="icon" type="button" onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-2 border-b border-cg-line px-4 py-3 sm:grid-cols-3">
          <label className="min-w-0 text-small text-cg-muted-strong">
            Type
            <select
              className={CONTROL}
              value={kind ?? ""}
              onChange={(event) => {
                resetResults();
                setKind((event.target.value || null) as SearchKind | null);
              }}
            >
              <option value="">All types</option>
              {Object.entries(SEARCH_KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-small text-cg-muted-strong">
            Workspace
            <select
              className={CONTROL}
              value={workspaceId}
              onChange={(event) => {
                const id = event.target.value;
                const selected = workspaces.find((item) => item.id === id);
                resetResults();
                setWorkspaceId(id);
                if (selected && !selected.repository_ids.includes(repositoryId)) {
                  setRepositoryId("");
                }
              }}
            >
              <option value="">All workspaces</option>
              {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-small text-cg-muted-strong">
            Repository
            <select
              className={CONTROL}
              value={repositoryId}
              onChange={(event) => {
                resetResults();
                setRepositoryId(event.target.value);
              }}
            >
              <option value="">All repositories</option>
              {visibleRepositories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        </div>
        <div className="min-h-0 max-h-[50vh] overflow-y-auto">
          {openError ? <p className="px-4 py-2 text-small text-cg-red" role="alert">{openError}</p> : null}
          {!term ? (
            <p className="px-4 py-5 text-ui text-cg-muted-strong">Find conversations, artifacts, tasks, and review comments.</p>
          ) : state.kind === "failed" ? (
            <div className="px-4 py-5" role="alert">
              <p className="mb-2 text-ui text-cg-ink">Search failed. {state.message}</p>
              <Button variant="secondary" onClick={() => { resetResults(); setRetry((count) => count + 1); }}>Try again</Button>
            </div>
          ) : results.length === 0 ? (
            <p className="px-4 py-5 text-ui text-cg-muted-strong" role="status">
              {state.kind === "loading" ? "Searching…" : "No matches. Try a different term or clear a filter."}
            </p>
          ) : (
            <>
              <p className="sr-only" role="status">
                {results.length === 60 ? "Top 60 results" : `${results.length} result${results.length === 1 ? "" : "s"}`}
              </p>
              <ul ref={resultsList} aria-busy={opening} aria-label="Search results" className="divide-y divide-cg-line" onKeyDown={onSearchKey}>
                {results.map((result) => (
                  <li key={result.documentId}>
                    <button
                      className="flex w-full cursor-pointer flex-col gap-0.5 px-4 py-2.5 text-left hover:bg-cg-tint focus-visible:bg-cg-tint focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cg-accent"
                      disabled={opening}
                      type="button"
                      onClick={() => void openResult(result)}
                    >
                      <span className="text-small text-cg-muted-strong">
                        {[SEARCH_KINDS[result.kind], result.workspace, result.repository !== result.workspace ? result.repository : null]
                          .filter(Boolean).join(" · ")}
                      </span>
                      <span className="w-full truncate text-ui font-semibold text-cg-ink">{result.title}</span>
                      {result.excerpt !== result.title ? (
                        <span className="line-clamp-2 break-words text-small text-cg-muted-strong">{result.excerpt}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>
    </Dialog>
  );
}
