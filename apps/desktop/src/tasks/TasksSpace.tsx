import { Check, ChevronDown, ChevronRight, Copy, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { taskCreate, taskDelete, tasksList, taskUpdate, type Task, type TaskPatch } from "../lib/tasks";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { LOADING, READY, StateMessage, type LoadState } from "../ui/State";
import { countOf, FILTERS, taskAsMessage, taskRef, titleToAdd, toggledDone, toggledReady, visibleTasks, type TaskFilter } from "./model";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The clipboard can be unavailable; the number is still on screen to be typed.
  }
}

/**
 * The developer's own task list. Typing a title and pressing Enter makes a task; everything else
 * is one click away on its card: whether it is ready for development, notes, deleting. Each task
 * has a number, `#12`, to name in a chat; the agent reads it through Ataraxia's API.
 */
export function TasksSpace({
  active,
  layout = "page",
  onError,
  searchNumber,
}: {
  active: boolean;
  /** `drawer`: inside the side panel, narrower and with no page margins. */
  layout?: "page" | "drawer";
  onError: (message: string) => void;
  searchNumber?: number | null;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [state, setState] = useState<LoadState>(LOADING);
  const [filter, setFilter] = useState<TaskFilter>("open");
  const [typed, setTyped] = useState("");
  const [openNumber, setOpenNumber] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const searchCard = useRef<HTMLLIElement>(null);
  const appliedSearch = useRef<number | null>(null);

  const load = useCallback(() => {
    setState(LOADING);
    tasksList()
      .then((found) => {
        setTasks(found);
        setState(READY);
      })
      .catch((err: unknown) => setState({ kind: "failed", message: errorText(err) }));
  }, []);
  useEffect(load, [load]);

  // Arriving here reads the list again (the agent may have changed it) and puts the cursor in the
  // field: adding a task is the first thing to do.
  const shownBefore = useRef(active);
  useEffect(() => {
    if (active && !shownBefore.current) {
      load();
    }
    shownBefore.current = active;
    if (active && searchNumber == null) {
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [active, load, searchNumber]);

  const foundTask = tasks.find((task) => task.number === searchNumber);
  useEffect(() => {
    if (!active || searchNumber == null) {
      appliedSearch.current = null;
    } else if (foundTask && appliedSearch.current !== foundTask.number) {
      appliedSearch.current = foundTask.number;
      setFilter(foundTask.status === "done" ? "done" : "open");
      setOpenNumber(foundTask.number);
    }
  }, [active, foundTask, searchNumber]);

  useEffect(() => {
    if (active && searchNumber != null && openNumber === searchNumber) {
      searchCard.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [active, searchNumber, openNumber, filter]);

  async function add() {
    const title = titleToAdd(typed);
    if (!title) {
      return;
    }
    setTyped("");
    try {
      const made = await taskCreate(title);
      setTasks((current) => [made, ...current]);
      // A task just made shows up under every view that would hide it.
      setFilter((current) => (current === "done" ? "open" : current));
    } catch (err) {
      setTyped(title);
      onError(errorText(err));
    }
  }

  async function change(number: number, patch: TaskPatch) {
    try {
      const updated = await taskUpdate(number, patch);
      setTasks((current) => current.map((item) => (item.number === number ? updated : item)));
    } catch (err) {
      onError(errorText(err));
    }
  }

  async function remove(number: number) {
    try {
      await taskDelete(number);
      setTasks((current) => current.filter((item) => item.number !== number));
      setOpenNumber((current) => (current === number ? null : current));
    } catch (err) {
      onError(errorText(err));
    }
  }

  const shown = visibleTasks(tasks, filter);

  return (
    <div
      className={
        layout === "drawer"
          ? "flex h-full min-h-0 w-full flex-col gap-4 overflow-y-auto px-5 pt-5 pb-6"
          : "mx-auto flex h-full min-h-0 w-full max-w-[760px] flex-col gap-4 overflow-y-auto px-8 pt-9 pb-8"
      }
    >
      <header className="flex flex-wrap items-baseline gap-3">
        <h1
          className={`mr-auto leading-snug font-semibold text-cg-ink ${
            layout === "drawer" ? "text-body" : "text-title tracking-[-0.3px]"
          }`}
        >
          Tasks
        </h1>
        <p className="text-small text-cg-muted">Say “#12” in a chat and the agent reads task 12.</p>
      </header>

      <form
        className="flex items-center gap-2 rounded-cg-lg bg-cg-tint px-3.5 py-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Plus aria-hidden="true" className="flex-none text-cg-muted-strong" size={16} />
        <input
          ref={input}
          aria-label="New task"
          autoComplete="off"
          className="min-w-0 flex-1 border-0 bg-transparent text-body text-cg-ink outline-none placeholder:text-cg-muted"
          maxLength={200}
          placeholder="Add a task and press Enter"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      </form>

      <div aria-label="Show" className="flex items-center gap-1" role="tablist">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            aria-selected={filter === item.id}
            className="rounded-cg-sm px-2.5 py-1 text-ui text-cg-muted-strong hover:bg-cg-tint aria-selected:bg-cg-tint aria-selected:font-semibold aria-selected:text-cg-ink"
            role="tab"
            type="button"
            onClick={() => setFilter(item.id)}
          >
            {item.label} <span className="text-cg-muted">{countOf(tasks, item.id)}</span>
          </button>
        ))}
      </div>

      {state.kind === "loading" ? <StateMessage text="Opening your tasks…" tone="loading" /> : null}
      {state.kind === "failed" ? (
        <StateMessage text={`The tasks did not open: ${state.message}`} tone="failed">
          <Button variant="secondary" onClick={load}>
            Try again
          </Button>
        </StateMessage>
      ) : null}
      {state.kind === "ready" && shown.length === 0 ? (
        <p className="px-1 py-6 text-ui text-cg-muted">
          {tasks.length === 0
            ? "No tasks yet. Type a title above and press Enter."
            : filter === "ready"
              ? "Nothing is marked ready for development. Open a task and mark it."
              : filter === "done"
                ? "Nothing is done yet."
                : "Everything is done."}
        </p>
      ) : null}

      <ul className="flex flex-col gap-1.5">
        {shown.map((task) => (
          <TaskCard
            key={task.number}
            cardRef={searchNumber === task.number ? searchCard : undefined}
            open={openNumber === task.number}
            task={task}
            onChange={(patch) => void change(task.number, patch)}
            onDelete={() => void remove(task.number)}
            onToggle={() => setOpenNumber((current) => (current === task.number ? null : task.number))}
          />
        ))}
      </ul>
    </div>
  );
}

function TaskCard({
  cardRef,
  task,
  open,
  onToggle,
  onChange,
  onDelete,
}: {
  cardRef?: React.Ref<HTMLLIElement>;
  task: Task;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: TaskPatch) => void;
  onDelete: () => void;
}) {
  const done = task.status === "done";
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [copied, setCopied] = useState<"ref" | "text" | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setNotes(task.notes), [task.notes]);
  useEffect(() => {
    if (!open) {
      setConfirming(false);
    }
  }, [open]);

  function commitTitle() {
    const clean = titleToAdd(title);
    if (clean && clean !== task.title) {
      onChange({ title: clean });
    } else {
      setTitle(task.title);
    }
  }

  function commitNotes() {
    if (notes.trimEnd() !== task.notes) {
      onChange({ notes });
    }
  }

  async function copyIt(what: "ref" | "text") {
    await copy(what === "ref" ? taskRef(task) : taskAsMessage(task));
    setCopied(what);
    window.setTimeout(() => setCopied(null), 1400);
  }

  return (
    <li ref={cardRef} className={`rounded-cg-md border ${open ? "border-cg-line-strong bg-cg-panel" : "border-cg-line"} transition-colors`}>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <button
          aria-checked={done}
          aria-label={done ? `Mark ${taskRef(task)} as not done` : `Mark ${taskRef(task)} as done`}
          className={`grid h-[18px] w-[18px] flex-none place-items-center rounded-full border ${
            done ? "border-cg-green bg-cg-green text-cg-on-primary" : "border-cg-control hover:border-cg-ink"
          }`}
          role="checkbox"
          type="button"
          onClick={() => onChange({ status: toggledDone(task.status) })}
        >
          {done ? <Check aria-hidden="true" size={12} /> : null}
        </button>
        <button
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          type="button"
          onClick={onToggle}
        >
          <span className="flex-none font-mono text-small text-cg-muted">{taskRef(task)}</span>
          <span className={`min-w-0 flex-1 truncate text-ui ${done ? "text-cg-muted line-through" : "text-cg-ink"}`}>
            {task.title}
          </span>
          {task.status === "ready" ? <Chip tone="info" title="Cleared to be developed">Ready for development</Chip> : null}
          {task.notes.trim() && !open ? (
            <span aria-label="Has notes" className="flex-none text-small text-cg-muted" title="Has notes">
              ¶
            </span>
          ) : null}
          {open ? (
            <ChevronDown aria-hidden="true" className="flex-none text-cg-muted" size={14} />
          ) : (
            <ChevronRight aria-hidden="true" className="flex-none text-cg-muted" size={14} />
          )}
        </button>
      </div>

      {open ? (
        <div className="flex flex-col gap-3 border-t border-cg-line px-3.5 pt-3 pb-3.5">
          <input
            aria-label={`Title of ${taskRef(task)}`}
            className="w-full rounded-cg-md border border-cg-control bg-cg-panel px-3 py-1.5 text-ui text-cg-ink focus:border-cg-ink"
            maxLength={200}
            value={title}
            onBlur={commitTitle}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
          <textarea
            aria-label={`Notes of ${taskRef(task)}`}
            className="min-h-[96px] w-full resize-y rounded-cg-md border border-cg-control bg-cg-panel px-3 py-2 text-ui leading-6 text-cg-ink placeholder:text-cg-muted focus:border-cg-ink"
            placeholder="What is wanted, where to look, what done means. Optional."
            value={notes}
            onBlur={commitNotes}
            onChange={(event) => setNotes(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              aria-pressed={task.status === "ready"}
              disabled={done}
              title="Say whether the task is clear enough for an agent to develop"
              variant="quiet"
              onClick={() => onChange({ status: toggledReady(task.status) })}
            >
              {task.status === "ready" ? <Check aria-hidden="true" size={13} /> : null}
              Ready for development
            </Button>
            <Button title="Copy the number to paste in a chat" variant="quiet" onClick={() => void copyIt("ref")}>
              <Copy aria-hidden="true" size={13} />
              {copied === "ref" ? "Copied" : `Copy ${taskRef(task)}`}
            </Button>
            <Button title="Copy the number, title and notes" variant="quiet" onClick={() => void copyIt("text")}>
              {copied === "text" ? "Copied" : "Copy as message"}
            </Button>
            <span className="ml-auto">
              {confirming ? (
                <span className="flex items-center gap-1.5 text-small">
                  <Button autoFocus size="sm" variant="danger" onClick={onDelete}>
                    Delete for good
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <Button aria-label={`Delete ${taskRef(task)}`} variant="icon" onClick={() => setConfirming(true)}>
                  <Trash2 aria-hidden="true" size={14} />
                </Button>
              )}
            </span>
          </div>
        </div>
      ) : null}
    </li>
  );
}
