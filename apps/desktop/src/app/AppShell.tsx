import { Button } from "@heroui/react";
import { Moon, Sun, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { isTypingTarget, nextSpace, SPACES, type SpaceId } from "./spaces";
import { useThemeMode } from "./theme";
import { ChatPanel } from "../chat/ChatPanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import {
  emptyWorkspace,
  workspaceBootstrap,
  workspaceCreateSession,
  workspaceOpenRepository,
  workspaceOpenSession,
  workspaceSelectRepository,
  workspaceSelectWorktree,
  type WorkspaceSnapshot,
} from "../lib/workspace";

function shortPath(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) {
    return path;
  }
  return parts.slice(-2).join("/");
}

function SpacePlaceholder({ spaceId }: { spaceId: SpaceId }) {
  const space = SPACES.find((item) => item.id === spaceId)!;
  return (
    <section className="flex h-full flex-col justify-center gap-3 px-10">
      <p className="text-sm uppercase tracking-[0.18em] text-foreground/50">
        {space.label}
      </p>
      <h1 className="max-w-2xl text-3xl font-medium tracking-tight text-foreground">
        {space.blurb}
      </h1>
      <p className="max-w-xl text-sm leading-6 text-foreground/60">
        {spaceId === "chat"
          ? "Crie ou selecione um chat para começar."
          : "Placeholder do espaço. A navegação e o chrome já seguem a SPEC; o conteúdo chega nas próximas PRs."}
      </p>
    </section>
  );
}

export function AppShell() {
  const [space, setSpace] = useState<SpaceId>("chat");
  const [coreStatus, setCoreStatus] = useState("checking…");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(emptyWorkspace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { theme, toggleTheme } = useThemeMode();

  useEffect(() => {
    let cancelled = false;
    invoke<string>("core_status")
      .then((status) => {
        if (!cancelled) {
          setCoreStatus(status);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setCoreStatus(err instanceof Error ? err.message : "core unavailable");
        }
      });
    workspaceBootstrap()
      .then((snapshot) => {
        if (!cancelled) {
          setWorkspace(snapshot);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }
      if (event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        setSpace((current) => nextSpace(current, -1));
      }
      if (event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        setSpace((current) => nextSpace(current, 1));
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        (event.key === "j" || event.key === "`")
      ) {
        event.preventDefault();
        setTerminalOpen((openPanel) => !openPanel);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectedRepository = useMemo(
    () =>
      workspace.repositories.find(
        (item) => item.id === workspace.selected_repository_id,
      ) ?? null,
    [workspace],
  );
  const selectedWorktree = useMemo(
    () =>
      workspace.worktrees.find(
        (item) => item.id === workspace.selected_worktree_id,
      ) ?? null,
    [workspace],
  );
  const selectedSession = useMemo(
    () =>
      workspace.sessions.find(
        (item) => item.id === workspace.selected_session_id,
      ) ?? null,
    [workspace],
  );

  async function runWorkspace(
    action: () => Promise<WorkspaceSnapshot>,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setWorkspace(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onOpenRepository() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open git repository",
    });
    if (typeof selected !== "string" || selected.length === 0) {
      return;
    }
    await runWorkspace(() => workspaceOpenRepository(selected));
  }

  async function onNewChat() {
    if (!selectedRepository || !selectedWorktree) {
      setError("Select a repository and worktree first");
      return;
    }
    await runWorkspace(() =>
      workspaceCreateSession(selectedRepository.id, selectedWorktree.id),
    );
    setSpace("chat");
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex h-12 items-center gap-3 border-b border-foreground/10 px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium tracking-tight">
            Concierge
          </div>
          <div className="truncate text-xs text-foreground/50">
            {error ?? coreStatus}
          </div>
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <Button
            size="sm"
            variant="ghost"
            isDisabled={busy}
            onPress={() => {
              void onOpenRepository();
            }}
          >
            {selectedRepository ? selectedRepository.name : "repository"}
          </Button>

          {workspace.repositories.length > 1 ? (
            <select
              aria-label="Repository"
              className="h-8 max-w-40 rounded-md border border-foreground/15 bg-transparent px-2 text-sm"
              disabled={busy}
              value={workspace.selected_repository_id ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                if (!value) {
                  return;
                }
                void runWorkspace(() => workspaceSelectRepository(value));
              }}
            >
              {workspace.repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
          ) : null}

          <select
            aria-label="Worktree"
            className="h-8 max-w-48 rounded-md border border-foreground/15 bg-transparent px-2 text-sm"
            disabled={!selectedRepository || workspace.worktrees.length === 0 || busy}
            value={workspace.selected_worktree_id ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) {
                return;
              }
              void runWorkspace(() => workspaceSelectWorktree(value));
            }}
          >
            {workspace.worktrees.length === 0 ? (
              <option value="">worktree</option>
            ) : null}
            {workspace.worktrees.map((worktree) => (
              <option key={worktree.id} value={worktree.id}>
                {worktree.branch ?? shortPath(worktree.path)}
              </option>
            ))}
          </select>

          <Button
            size="sm"
            variant="secondary"
            isDisabled={!selectedRepository || !selectedWorktree || busy}
            onPress={() => {
              void onNewChat();
            }}
          >
            New chat
          </Button>

          <select
            aria-label="Sessions"
            className="h-8 max-w-48 rounded-md border border-foreground/15 bg-transparent px-2 text-sm"
            disabled={!selectedRepository || busy}
            value={workspace.selected_session_id ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) {
                return;
              }
              void runWorkspace(async () => {
                const snapshot = await workspaceOpenSession(value);
                setSpace("chat");
                return snapshot;
              });
            }}
          >
            <option value="">
              {workspace.sessions.length === 0 ? "No sessions" : "Sessions"}
            </option>
            {workspace.sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1">
          <Button
            isIconOnly
            aria-label="Toggle terminal"
            size="sm"
            variant={terminalOpen ? "secondary" : "ghost"}
            isDisabled={!selectedWorktree}
            onPress={() => setTerminalOpen((openPanel) => !openPanel)}
          >
            <TerminalSquare size={16} />
          </Button>
          <Button
            isIconOnly
            aria-label="Toggle theme"
            size="sm"
            variant="ghost"
            onPress={toggleTheme}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {space === "chat" && selectedSession ? (
          <ChatPanel key={selectedSession.id} session={selectedSession} />
        ) : (
          <SpacePlaceholder spaceId={space} />
        )}

        <nav
          aria-label="Spaces"
          className="absolute top-1/2 right-3 flex -translate-y-1/2 flex-col gap-2"
        >
          {SPACES.map((item) => {
            const selected = item.id === space;
            return (
              <button
                key={item.id}
                aria-current={selected ? "page" : undefined}
                aria-label={item.label}
                className={
                  selected
                    ? "h-2.5 w-2.5 rounded-full bg-foreground"
                    : "h-2.5 w-2.5 rounded-full bg-foreground/25 hover:bg-foreground/50"
                }
                title={item.label}
                type="button"
                onClick={() => setSpace(item.id)}
              />
            );
          })}
        </nav>
      </div>

      {terminalOpen && selectedWorktree ? (
        <TerminalPanel
          key={selectedWorktree.id}
          worktreeId={selectedWorktree.id}
          cwd={selectedWorktree.path}
        />
      ) : null}
    </div>
  );
}
