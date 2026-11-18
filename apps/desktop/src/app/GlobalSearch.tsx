import {
  Bot,
  CornerDownLeft,
  FolderGit2,
  GitCommitHorizontal,
  ListOrdered,
  ListChecks,
  Layers,
  Loader2,
  MessageSquare,
  MessageSquareCode,
  MessagesSquare,
  Scale,
  Search,
  SearchX,
  Shapes,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useId, useState, type KeyboardEvent } from "react";
import { globalSearch, markTerms, SEARCH_KINDS, type SearchKind, type SearchResult } from "../lib/search";
import type { Repository, Workspace } from "../lib/workspace";
import { Button } from "../ui/Button";
import { Key, Dialog } from "../ui/Overlay";
import { QuietSelect } from "../ui/QuietSelect";

type SearchState =
  | { kind: "loading" }
  | { kind: "ready"; results: SearchResult[] }
  | { kind: "failed"; message: string };

const KIND_ICON: Record<SearchKind, LucideIcon> = {
  chat: MessagesSquare,
  message: MessageSquare,
  subagent: Bot,
  checkpoint: GitCommitHorizontal,
  flow: Workflow,
  decision: Scale,
  decision_item: Scale,
  review_priority: ListOrdered,
  review_comment: MessageSquareCode,
  btw: Sparkles,
  task: ListChecks,
};

/** What can be found, shown while nothing has been typed. */
const FINDS: { icon: LucideIcon; label: string }[] = [
  { icon: MessagesSquare, label: "Conversations" },
  { icon: Shapes, label: "Artifacts" },
  { icon: ListChecks, label: "Tasks" },
  { icon: MessageSquareCode, label: "Review comments" },
];

const RESULT_LIMIT = 60;

/** `text` with the words that were searched for picked out. */
function Marked({ text, term }: { text: string; term: string }) {
  return (
    <>
      {markTerms(text, term).map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-[3px] bg-cg-accent-bg px-0.5 text-cg-accent">
            {part.text}
          </mark>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

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
  const [active, setActive] = useState(0);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const listId = useId();
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const visibleRepositories = workspace
    ? repositories.filter((item) => workspace.repository_ids.includes(item.id))
    : repositories;
  const term = query.trim();
  const filtered = kind !== null || workspaceId !== "" || repositoryId !== "";

  useEffect(() => {
    if (!term) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void globalSearch({ query: term, kind, workspaceId: workspaceId || null, repositoryId: repositoryId || null })
        .then((results) => {
          if (!cancelled) {
            setActive(0);
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
  const current = Math.min(active, Math.max(0, results.length - 1));
  const optionId = (index: number) => `${listId}-option-${index}`;

  // The row the arrow keys are on stays in view.
  useEffect(() => {
    document.getElementById(`${listId}-option-${current}`)?.scrollIntoView?.({ block: "nearest" });
  }, [current, listId, results]);

  function resetResults() {
    setState({ kind: "loading" });
    setOpenError(null);
  }

  function clearFilters() {
    resetResults();
    setKind(null);
    setWorkspaceId("");
    setRepositoryId("");
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

  // Focus stays in the field, as in a command palette: the arrows move a highlight, Enter opens it.
  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (event.key === "Enter") {
      const result = results[current];
      if (result) {
        event.preventDefault();
        void openResult(result);
      }
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length > 0) {
      event.preventDefault();
      setActive((current + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    }
  }

  return (
    <Dialog isOpen wide placement="top" label="Global search" onClose={onClose}>
      <section className="flex max-h-[75dvh] min-h-0 flex-col overflow-hidden rounded-cg-lg">
        <div role="search" className="flex items-center gap-3.5 px-5 pt-4 pb-3">
          <Search aria-hidden="true" className="shrink-0 text-cg-muted-strong" size={20} />
          <input
            aria-activedescendant={results.length > 0 ? optionId(current) : undefined}
            aria-autocomplete="list"
            aria-controls={results.length > 0 ? listId : undefined}
            aria-expanded={results.length > 0}
            aria-label="Search Ataraxia"
            autoFocus
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent py-1 text-[1.1875rem] leading-7 text-cg-ink outline-none placeholder:text-cg-muted"
            placeholder="Search Ataraxia"
            role="combobox"
            spellCheck={false}
            type="text"
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
          <button
            aria-label="Close search"
            className="flex-none cursor-pointer rounded-cg-sm border border-cg-line px-1.5 py-0.5 text-small text-cg-muted hover:border-cg-control hover:text-cg-ink focus-visible:outline-2 focus-visible:outline-cg-accent"
            type="button"
            onClick={onClose}
          >
            esc
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 pb-3.5">
          <QuietSelect
            aria-label="Type"
            highlighted={kind !== null}
            icon={<Layers size={13} />}
            options={[
              { value: "", label: "All types" },
              ...Object.entries(SEARCH_KINDS).map(([value, label]) => ({ value, label })),
            ]}
            searchable
            value={kind ?? ""}
            variant="chip"
            onChange={(value) => {
              resetResults();
              setKind((value || null) as SearchKind | null);
            }}
          />
          <QuietSelect
            aria-label="Workspace"
            highlighted={workspaceId !== ""}
            icon={<Shapes size={13} />}
            options={[{ value: "", label: "All workspaces" }, ...workspaces.map((item) => ({ value: item.id, label: item.name }))]}
            searchable={workspaces.length > 6}
            value={workspaceId}
            variant="chip"
            onChange={(id) => {
              const selected = workspaces.find((item) => item.id === id);
              resetResults();
              setWorkspaceId(id);
              if (selected && !selected.repository_ids.includes(repositoryId)) {
                setRepositoryId("");
              }
            }}
          />
          <QuietSelect
            aria-label="Repository"
            highlighted={repositoryId !== ""}
            icon={<FolderGit2 size={13} />}
            options={[{ value: "", label: "All repositories" }, ...visibleRepositories.map((item) => ({ value: item.id, label: item.name }))]}
            searchable={visibleRepositories.length > 6}
            value={repositoryId}
            variant="chip"
            onChange={(id) => {
              resetResults();
              setRepositoryId(id);
            }}
          />
          {filtered ? (
            <button
              className="cursor-pointer rounded-cg-sm px-1.5 py-1 text-small text-cg-muted hover:text-cg-ink focus-visible:outline-2 focus-visible:outline-cg-accent"
              type="button"
              onClick={clearFilters}
            >
              Clear
            </button>
          ) : null}
        </div>

        <div className="min-h-0 max-h-[min(50vh,420px)] overflow-y-auto border-t border-cg-line">
          {openError ? (
            <p className="px-5 py-2 text-small text-cg-red" role="alert">
              {openError}
            </p>
          ) : null}
          {!term ? (
            <div className="flex flex-col items-center gap-3.5 px-5 py-8 text-center">
              <p className="text-ui text-cg-muted-strong">Find anything you have done here.</p>
              <ul className="flex flex-wrap justify-center gap-2">
                {FINDS.map(({ icon: Icon, label }) => (
                  <li key={label} className="flex items-center gap-1.5 rounded-full bg-cg-tint px-3 py-1.5 text-small text-cg-muted-strong">
                    <Icon aria-hidden="true" size={13} />
                    {label}
                  </li>
                ))}
              </ul>
            </div>
          ) : state.kind === "failed" ? (
            <div className="flex flex-col items-center gap-3 px-5 py-8 text-center" role="alert">
              <p className="text-ui text-cg-ink">Search failed. {state.message}</p>
              <Button
                variant="secondary"
                onClick={() => {
                  resetResults();
                  setRetry((count) => count + 1);
                }}
              >
                Try again
              </Button>
            </div>
          ) : results.length === 0 ? (
            state.kind === "loading" ? (
              <p className="flex items-center justify-center gap-2 px-5 py-8 text-ui text-cg-muted-strong" role="status">
                <Loader2 aria-hidden="true" className="animate-spin" size={14} />
                Searching…
              </p>
            ) : (
              <div className="flex flex-col items-center gap-2 px-5 py-8 text-center" role="status">
                <SearchX aria-hidden="true" className="text-cg-muted" size={22} />
                <p className="text-ui text-cg-ink">No matches for “{term}”</p>
                <p className="text-small text-cg-muted-strong">Try a different word{filtered ? " or clear a filter" : ""}.</p>
                {filtered ? (
                  <Button variant="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : null}
              </div>
            )
          ) : (
            <>
              <p className="sr-only" role="status">
                {results.length === RESULT_LIMIT ? `Top ${RESULT_LIMIT} results` : `${results.length} result${results.length === 1 ? "" : "s"}`}
              </p>
              <ul id={listId} aria-busy={opening} aria-label="Search results" className="flex flex-col gap-0.5 p-2" role="listbox">
                {results.map((result, index) => {
                  const Icon = KIND_ICON[result.kind];
                  const place = [result.workspace, result.repository !== result.workspace ? result.repository : null].filter(Boolean).join(" · ");
                  return (
                    <li
                      key={result.documentId}
                      id={optionId(index)}
                      aria-selected={index === current}
                      className={`flex cursor-pointer items-center gap-3 rounded-cg-md px-3 py-2.5 ${
                        index === current ? "bg-cg-tint" : ""
                      } ${opening ? "pointer-events-none opacity-60" : ""}`}
                      role="option"
                      onClick={() => void openResult(result)}
                      onMouseMove={() => index !== current && setActive(index)}
                    >
                      <span
                        aria-hidden="true"
                        className={`grid h-8 w-8 flex-none place-items-center rounded-cg-md ${
                          index === current ? "bg-cg-accent-bg text-cg-accent" : "bg-cg-tint text-cg-muted-strong"
                        }`}
                      >
                        <Icon size={15} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-ui font-medium text-cg-ink">
                          <Marked term={term} text={result.title} />
                        </span>
                        {result.excerpt !== result.title ? (
                          <span className="line-clamp-2 break-words text-small text-cg-muted-strong">
                            <Marked term={term} text={result.excerpt} />
                          </span>
                        ) : null}
                        {place ? <span className="truncate text-small text-cg-muted">{place}</span> : null}
                      </span>
                      {index === current ? (
                        <CornerDownLeft aria-hidden="true" className="flex-none text-cg-muted-strong" size={14} />
                      ) : (
                        <span className="flex-none text-small text-cg-muted">{SEARCH_KINDS[result.kind]}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-cg-line px-5 py-2.5 text-small text-cg-muted">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Key>↑</Key>
              <Key>↓</Key>
              <span className="ml-1">move</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Key>↵</Key>
              open
            </span>
            <span className="flex items-center gap-1.5">
              <Key>esc</Key>
              close
            </span>
          </span>
          {results.length > 0 ? (
            <span aria-hidden="true">{results.length === RESULT_LIMIT ? `Top ${RESULT_LIMIT}` : `${results.length} result${results.length === 1 ? "" : "s"}`}</span>
          ) : null}
        </footer>
      </section>
    </Dialog>
  );
}
