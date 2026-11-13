import { Check, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { PROVIDER_LABELS } from "../lib/agent";
import type { ChatSession, SessionId, Worktree } from "../lib/workspace";

function worktreeLabel(worktree: Worktree | undefined): string {
  if (!worktree) {
    return "unknown worktree";
  }
  if (worktree.branch) {
    return worktree.branch;
  }
  const parts = worktree.path.split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

export function SessionsPanel({
  sessions,
  worktrees,
  selectedId,
  onSelect,
  onClose,
}: {
  sessions: ChatSession[];
  worktrees: Worktree[];
  selectedId: SessionId | null;
  onSelect: (id: SessionId) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target || ref.current?.contains(target)) {
        return;
      }
      // The toggle button handles its own click; ignore it here so it can close the panel.
      if (target instanceof Element && target.closest("[data-sessions-toggle]")) {
        return;
      }
      onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  const groups = [...new Set(sessions.map((session) => session.worktree_id))];

  return (
    <aside
      ref={ref}
      aria-label="Chat sessions"
      className="absolute top-[54px] right-[75px] z-30 flex max-h-[min(540px,75vh)] w-[24.5rem] flex-col overflow-hidden rounded-cg-lg border border-cg-line bg-cg-panel shadow-cg-pop"
    >
      <div className="flex h-[55px] flex-none items-center justify-between border-b border-cg-line px-5 text-small font-semibold text-cg-muted-strong">
        <h2>Sessions</h2>
        <button
          aria-label="Close sessions"
          className="grid h-7 w-7 place-items-center rounded-cg-sm text-cg-muted-strong hover:bg-cg-tint hover:text-cg-ink"
          type="button"
          onClick={onClose}
        >
          <X aria-hidden="true" size={15} />
        </button>
      </div>
      <div className="overflow-auto px-2.5 pt-3.5 pb-5">
        {sessions.length === 0 ? (
          <p className="px-4 py-7 text-center text-ui text-cg-muted">
            No sessions in this repository yet.
          </p>
        ) : (
          groups.map((worktreeId) => (
            <div key={worktreeId} className="mb-4">
              <div className="mx-3 mt-2 mb-2.5 font-mono text-small text-cg-muted">
                {worktreeLabel(worktrees.find((item) => item.id === worktreeId))}
              </div>
              {sessions
                .filter((session) => session.worktree_id === worktreeId)
                .map((session) => (
                  <button
                    key={session.id}
                    aria-current={session.id === selectedId ? "true" : undefined}
                    className={`flex w-full items-start gap-3 rounded-cg-md px-3 py-3 text-left hover:bg-cg-tint ${
                      session.id === selectedId ? "bg-cg-tint" : ""
                    }`}
                    type="button"
                    onClick={() => onSelect(session.id)}
                  >
                    {session.id === selectedId ? (
                      <Check aria-hidden="true" className="mt-0.5 flex-none text-cg-accent" size={14} />
                    ) : (
                      <span aria-hidden="true" className="mt-1 h-3.5 w-3.5 flex-none" />
                    )}
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-ui font-semibold">
                        {session.title}
                      </strong>
                      <small className="mt-1.5 block text-small text-cg-muted">
                        {PROVIDER_LABELS[session.provider]}
                      </small>
                    </span>
                  </button>
                ))}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
