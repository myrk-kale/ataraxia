import { MessageCircle, Moon, Plus, Sun, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  agentListProviders,
  agentSwitchProvider,
  PROVIDER_LABELS,
  type ProviderDescriptor,
} from "../lib/agent";
import { ChatPanel } from "../chat/ChatPanel";
import { NewContext } from "../chat/NewContext";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { Button } from "../ui/Button";
import { QuietSelect } from "../ui/QuietSelect";
import {
  emptyWorkspace,
  workspaceBootstrap,
  workspaceCreateSession,
  workspaceOpenRepository,
  workspaceOpenSession,
  workspaceSelectRepository,
  workspaceSelectWorktree,
  type ProviderKind,
  type WorkspaceSnapshot,
} from "../lib/workspace";
import { EdgeNav } from "./EdgeNav";
import { SessionsPanel } from "./SessionsPanel";
import { Toast } from "./Toast";
import { isTypingTarget, nextSpace, SPACES, type SpaceId } from "./spaces";
import { useThemeMode } from "./theme";
import { Wordmark } from "./Wordmark";

const PROVIDER_STORAGE_KEY = "ataraxia.newChatProvider";

function readStoredProvider(): ProviderKind {
  try {
    const stored = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (
      stored === "fake" ||
      stored === "opencode" ||
      stored === "claude" ||
      stored === "codex"
    ) {
      return stored;
    }
  } catch {
    // Storage can be unavailable; the default is fine.
  }
  return "fake";
}

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
    <section className="cg-page-in mx-auto mt-[16vh] flex max-w-[650px] flex-col items-center gap-3 px-[30px] text-center">
      <p className="text-micro font-bold tracking-[1.15px] text-cg-muted-strong uppercase">
        {space.label}
      </p>
      <h1 className="text-display leading-tight font-semibold tracking-[-0.6px] text-cg-ink">
        {space.blurb}
      </h1>
      <p className="text-small leading-6 text-cg-muted">
        Este espaço já segue a navegação e o visual do protótipo. O conteúdo chega nas próximas PRs.
      </p>
    </section>
  );
}

export function AppShell() {
  const [space, setSpace] = useState<SpaceId>("chat");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(emptyWorkspace);
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [preferredProvider, setPreferredProvider] = useState<ProviderKind>(
    readStoredProvider,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { theme, toggleTheme } = useThemeMode();

  useEffect(() => {
    let cancelled = false;
    // The core check only matters when it fails; a healthy core stays silent.
    invoke<string>("core_status").catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : "core unavailable");
      }
    });
    agentListProviders()
      .then((items) => {
        if (!cancelled) {
          setProviders(items);
        }
      })
      .catch(() => undefined);
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

  const provider: ProviderKind =
    providers.find((item) => item.kind === preferredProvider && item.available)
      ?.kind ??
    providers.find((item) => item.available)?.kind ??
    "fake";

  function onProviderChange(next: ProviderKind) {
    setPreferredProvider(next);
    try {
      window.localStorage.setItem(PROVIDER_STORAGE_KEY, next);
    } catch {
      // Not persisting the choice is harmless.
    }
  }

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

  // With a chat open the selector shows (and changes) that chat's harness; otherwise it picks
  // the harness for the next new chat.
  const harness: ProviderKind = selectedSession?.provider ?? provider;

  async function onHarnessChange(next: ProviderKind) {
    onProviderChange(next);
    if (!selectedSession || selectedSession.provider === next) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await agentSwitchProvider(selectedSession.id, next);
      setWorkspace((current) => ({
        ...current,
        sessions: current.sessions.map((item) => (item.id === updated.id ? updated : item)),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const sessionId = selectedSession?.id ?? null;
  useEffect(() => {
  }, [sessionId]);

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
    setSessionsOpen(false);
    await runWorkspace(() =>
      workspaceCreateSession(
        selectedRepository.id,
        selectedWorktree.id,
        undefined,
        provider,
      ),
    );
    setSpace("chat");
  }

  const closeSessions = useCallback(() => setSessionsOpen(false), []);
  const contextLabel = selectedRepository
    ? [selectedRepository.name, selectedWorktree?.branch ?? null]
        .filter(Boolean)
        .join(" · ")
    : null;
  const spaceLabel = SPACES.find((item) => item.id === space)!.label;
  const canCreate = Boolean(selectedRepository && selectedWorktree) && !busy;

  return (
    <div className="relative flex h-full flex-col bg-cg-panel text-cg-ink">
      <header className="flex h-[61px] flex-none items-center justify-between gap-4 border-b border-cg-line px-[29px]">
        <div className="flex min-w-0 items-center gap-2.5 text-ui font-semibold whitespace-nowrap">
          <Wordmark />
          {workspace.repositories.length === 0 ? (
            <button
              className="rounded-[5px] py-1.5 text-cg-ink hover:text-cg-accent"
              disabled={busy}
              type="button"
              onClick={() => {
                void onOpenRepository();
              }}
            >
              Open repository
            </button>
          ) : (
            <QuietSelect
              aria-label="Repository"
              actions={[{ label: "Open folder…", onSelect: () => void onOpenRepository() }]}
              className="max-w-[210px] text-ui font-semibold text-cg-ink"
              disabled={busy}
              options={workspace.repositories.map((repo) => ({ value: repo.id, label: repo.name }))}
              value={workspace.selected_repository_id ?? ""}
              onChange={(value) => {
                void runWorkspace(() => workspaceSelectRepository(value));
              }}
            />
          )}

          <span aria-hidden="true" className="text-cg-line-strong">
            /
          </span>

          <QuietSelect
            aria-label="Worktree"
            className="max-w-[175px] text-ui font-medium text-cg-muted-strong"
            disabled={!selectedRepository || workspace.worktrees.length === 0 || busy}
            options={workspace.worktrees.map((worktree) => ({
              value: worktree.id,
              label: worktree.branch ?? shortPath(worktree.path),
            }))}
            placeholder="worktree"
            value={workspace.selected_worktree_id ?? ""}
            onChange={(value) => {
              void runWorkspace(() => workspaceSelectWorktree(value));
            }}
          />

          <span aria-hidden="true" className="text-cg-line-strong">
            /
          </span>
          <span>{spaceLabel}</span>
        </div>

        <div className="flex flex-none items-center gap-[9px]">
          <QuietSelect
            aria-label="Provider"
            className="max-w-[130px] text-small text-cg-muted-strong"
            disabled={busy || providers.length === 0}
            options={providers.map((item) => ({
              value: item.kind,
              label: `${item.display_name}${item.available ? "" : " (unavailable)"}`,
              disabled: !item.available,
              hint: item.detail ?? undefined,
            }))}
            title={selectedSession ? "Harness for this chat" : "Provider for new chats"}
            value={harness}
            onChange={(value) => {
              void onHarnessChange(value as ProviderKind);
            }}
          />

          <Button
            aria-label="New chat"
            disabled={!canCreate}
            title="New chat"
            variant="icon"
            onClick={() => {
              void onNewChat();
            }}
          >
            <Plus size={16} />
          </Button>
          <Button
            aria-label="Sessions in this repository"
            aria-pressed={sessionsOpen}
            data-sessions-toggle
            disabled={!selectedRepository}
            title="Sessions in this repository"
            variant="icon"
            onClick={() => setSessionsOpen((current) => !current)}
          >
            <MessageCircle size={16} />
          </Button>
          <Button
            aria-label="Toggle terminal"
            aria-pressed={terminalOpen}
            disabled={!selectedWorktree}
            title="Terminal (Ctrl + `)"
            variant="icon"
            onClick={() => setTerminalOpen((openPanel) => !openPanel)}
          >
            <TerminalSquare size={16} />
          </Button>
          <Button
            aria-label="Toggle theme"
            title="Toggle theme"
            variant="icon"
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 pr-[37px]">
        {space === "chat" && selectedSession ? (
          <ChatPanel
            key={selectedSession.id}
            contextLabel={contextLabel}
            provider={providers.find((item) => item.kind === selectedSession.provider) ?? null}
            session={selectedSession}
            onSessionChange={(updated) =>
              setWorkspace((current) => ({
                ...current,
                sessions: current.sessions.map((item) =>
                  item.id === updated.id ? updated : item,
                ),
              }))
            }
          />
        ) : space === "chat" ? (
          <NewContext
            busy={busy}
            canCreate={canCreate}
            contextLabel={contextLabel}
            hasRepository={Boolean(selectedRepository)}
            providerLabel={PROVIDER_LABELS[provider]}
            onNewChat={() => {
              void onNewChat();
            }}
            onOpenRepository={() => {
              void onOpenRepository();
            }}
          />
        ) : (
          <SpacePlaceholder spaceId={space} />
        )}

        {sessionsOpen ? (
          <SessionsPanel
            selectedId={workspace.selected_session_id}
            sessions={workspace.sessions}
            worktrees={workspace.worktrees}
            onClose={closeSessions}
            onSelect={(id) => {
              setSessionsOpen(false);
              void runWorkspace(async () => {
                const snapshot = await workspaceOpenSession(id);
                setSpace("chat");
                return snapshot;
              });
            }}
          />
        ) : null}
      </div>

      {terminalOpen && selectedWorktree ? (
        <TerminalPanel
          key={selectedWorktree.id}
          cwd={selectedWorktree.path}
          theme={theme}
          worktreeId={selectedWorktree.id}
          onClose={() => setTerminalOpen(false)}
        />
      ) : null}

      <EdgeNav space={space} onSelect={setSpace} />
      <Toast message={error} onDismiss={() => setError(null)} />
    </div>
  );
}
