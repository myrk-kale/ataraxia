import { Check, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PROVIDER_LABELS } from "../lib/agent";
import type { ChatSession, RepositoryId, SessionId, Workspace, WorkspaceId, Worktree } from "../lib/workspace";

/** Where a chat runs, for its second line: the repository (when the workspace has several) and the branch. */
export function placeLabel(
  worktree: Worktree | undefined,
  repositoryNames: Record<RepositoryId, string> | undefined,
): string | null {
  if (!worktree) {
    return null;
  }
  const parts = worktree.path.split(/[/\\]/).filter(Boolean);
  const place = worktree.branch ?? parts.slice(-2).join("/");
  const repository = repositoryNames?.[worktree.repository_id];
  return repository ? `${repository} · ${place}` : place;
}

/**
 * The chats, grouped by workspace: the one on screen first, then each other, in the order the
 * workspaces are listed. A workspace with no chats is not shown, except the one on screen.
 */
export function groupByWorkspace(
  workspaces: readonly Workspace[],
  currentId: WorkspaceId | null,
  current: readonly ChatSession[],
  others: readonly ChatSession[],
): { workspace: Workspace; sessions: ChatSession[]; current: boolean }[] {
  const groups: { workspace: Workspace; sessions: ChatSession[]; current: boolean }[] = [];
  for (const workspace of workspaces) {
    const isCurrent = workspace.id === currentId;
    const sessions = isCurrent ? [...current] : others.filter((item) => item.workspace_id === workspace.id);
    if (isCurrent || sessions.length > 0) {
      groups.push({ workspace, sessions, current: isCurrent });
    }
  }
  return groups.sort((a, b) => Number(b.current) - Number(a.current));
}

export function SessionsPanel({
  sessions,
  otherSessions = [],
  workspaces = [],
  currentWorkspaceId = null,
  worktrees,
  repositoryNames,
  selectedId,
  onSelect,
  onDelete,
  onClose,
}: {
  /** The chats of the workspace on screen. */
  sessions: ChatSession[];
  /** The chats of every other workspace. Choosing one moves to its workspace. */
  otherSessions?: ChatSession[];
  workspaces?: Workspace[];
  currentWorkspaceId?: WorkspaceId | null;
  worktrees: Worktree[];
  /** Names of the repositories, given when the workspace has more than one: each group then says which. */
  repositoryNames?: Record<RepositoryId, string>;
  selectedId: SessionId | null;
  onSelect: (id: SessionId) => void;
  /** Deletes the chat for good. Asked for twice here, so one slip never costs a conversation. */
  onDelete: (id: SessionId) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  // The chat whose delete is waiting for a second, deliberate click.
  const [confirming, setConfirming] = useState<SessionId | null>(null);
  const confirmingRef = useRef(confirming);
  confirmingRef.current = confirming;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Escape backs out of one step at a time.
        if (confirmingRef.current) {
          setConfirming(null);
        } else {
          onClose();
        }
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

  const groups = groupByWorkspace(workspaces, currentWorkspaceId, sessions, otherSessions);

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
        {groups.length === 0 ? (
          <p className="px-4 py-7 text-center text-ui text-cg-muted">No chats yet.</p>
        ) : (
          groups.map((group) => (
            <div key={group.workspace.id} className="mb-4">
              <div className="mx-3 mt-2 mb-2.5 flex items-baseline justify-between gap-2 text-small text-cg-muted">
                <span className="truncate font-semibold text-cg-muted-strong">{group.workspace.name}</span>
                {group.current ? <span className="flex-none">this workspace</span> : null}
              </div>
              {group.sessions.length === 0 ? (
                <p className="px-3 py-2 text-small text-cg-muted">No chats in this workspace yet.</p>
              ) : null}
              {group.sessions
                .map((session) => {
                  const selected = session.id === selectedId;
                  const asking = confirming === session.id;
                  return (
                    <div
                      key={session.id}
                      className={`group flex items-start gap-1 rounded-cg-md hover:bg-cg-tint focus-within:bg-cg-tint ${
                        selected ? "bg-cg-tint" : ""
                      }`}
                    >
                      <button
                        aria-current={selected ? "true" : undefined}
                        className="flex min-w-0 flex-1 items-start gap-3 rounded-cg-md px-3 py-3 text-left"
                        type="button"
                        onClick={() => onSelect(session.id)}
                      >
                        {selected ? (
                          <Check aria-hidden="true" className="mt-0.5 flex-none text-cg-accent" size={14} />
                        ) : (
                          <span aria-hidden="true" className="mt-1 h-3.5 w-3.5 flex-none" />
                        )}
                        <span className="min-w-0 flex-1">
                          <strong className="block truncate text-ui font-semibold">
                            {session.title}
                          </strong>
                          <small className="mt-1.5 block text-small text-cg-muted">
                            {asking
                              ? "Its messages, decisions and diagrams are deleted. The code is not touched."
                              : [
                                  PROVIDER_LABELS[session.provider],
                                  group.current ? placeLabel(worktrees.find((item) => item.id === session.worktree_id), repositoryNames) : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                          </small>
                        </span>
                      </button>
                      {asking ? (
                        <div className="flex flex-none items-center gap-1 py-2.5 pr-2">
                          <button
                            autoFocus
                            aria-label={`Delete ${session.title} for good`}
                            className="rounded-cg-sm bg-cg-del-bg px-2.5 py-1 text-small font-semibold text-cg-del-fg hover:underline"
                            type="button"
                            onClick={() => {
                              setConfirming(null);
                              onDelete(session.id);
                            }}
                          >
                            Delete
                          </button>
                          <button
                            className="rounded-cg-sm px-2 py-1 text-small text-cg-muted-strong hover:bg-cg-line hover:text-cg-ink"
                            type="button"
                            onClick={() => setConfirming(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          aria-label={`Delete ${session.title}`}
                          className="mt-2.5 mr-2 grid h-7 w-7 flex-none place-items-center rounded-cg-sm text-cg-muted hover:bg-cg-line hover:text-cg-del-fg focus-visible:bg-cg-line"
                          title="Delete this chat"
                          type="button"
                          onClick={() => setConfirming(session.id)}
                        >
                          <Trash2 aria-hidden="true" size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
