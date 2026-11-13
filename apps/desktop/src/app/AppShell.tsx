import {
  Keyboard,
  Layers,
  Loader2,
  MessageCircle,
  Moon,
  Plus,
  Settings,
  ShieldAlert,
  Sun,
  TerminalSquare,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  agentListProviders,
  agentSwitchProvider,
  PROVIDER_LABELS,
  type ProviderDescriptor,
} from "../lib/agent";
import { BtwPalette } from "../btw/BtwPalette";
import { ChatPanel } from "../chat/ChatPanel";
import { CodeSpace } from "../code/CodeSpace";
import { DecisionsSpace } from "../decisions/DecisionsSpace";
import { FlowSpace } from "../flow/FlowSpace";
import type { BtwTask } from "../lib/insights";
import { NewContext } from "../chat/NewContext";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { QuietSelect } from "../ui/QuietSelect";
import { ReferenceSelect } from "./ReferenceSelect";
import { Tip } from "../ui/Overlay";
import { StateMessage, type LoadState } from "../ui/State";
import {
  emptyWorkspace,
  workspaceBootstrap,
  workspaceCreateSession,
  workspaceOpenRepository,
  workspaceOpenSession,
  workspaceSelectRepository,
  workspaceListBranches,
  workspaceSelectBranch,
  type BranchView,
  type ProviderKind,
  type WorkspaceSnapshot,
} from "../lib/workspace";
import { BrandMark } from "../intro/BrandMark";
import { ArtifactsDrawer } from "./ArtifactsDrawer";
import { EdgeNav } from "./EdgeNav";
import { SessionsPanel } from "./SessionsPanel";
import { SettingsDialog } from "./SettingsDialog";
import { ShortcutLegend } from "./ShortcutLegend";
import { Toast } from "./Toast";
import { newBridge } from "./spaceCommands";
import { resolveShortcut } from "./shortcuts";
import { nextSpace, SPACES, type SpaceId } from "./spaces";
import { pickProvider, visibleProviders } from "./providers";
import { useThemeMode } from "./theme";
import { useFailedArtifacts, useSessionActivity } from "./useSessionActivity";

const PROVIDER_STORAGE_KEY = "ataraxia.newChatProvider";

function readStoredProvider(): ProviderKind | null {
  try {
    const stored = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (stored === "opencode" || stored === "claude" || stored === "codex") {
      return stored;
    }
    if (stored === "fake" && import.meta.env.DEV) {
      return stored;
    }
  } catch {
    // Storage can be unavailable; no remembered choice is fine.
  }
  return null;
}

/** Whether two snapshots show the same worktrees on the same branches, so nothing needs redrawing. */
function sameBranches(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
  const key = (snapshot: WorkspaceSnapshot) =>
    JSON.stringify([
      snapshot.selected_worktree_id,
      snapshot.worktrees.map((item) => [item.id, item.branch]),
    ]);
  return key(a) === key(b);
}

function readReference(chatId: string | null): string {
  if (!chatId) {
    return "";
  }
  try {
    return window.localStorage.getItem(`ataraxia.compareWith.${chatId}`) ?? "";
  } catch {
    return "";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function AppShell() {
  const [space, setSpace] = useState<SpaceId>("chat");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [btwOpen, setBtwOpen] = useState(false);
  const [btwResume, setBtwResume] = useState<BtwTask | null>(null);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [codeRequest, setCodeRequest] = useState<{ path: string; line: number | null; n: number } | null>(null);
  // Spaces stay mounted once visited, so the open file, the selected decision and the diagram
  // are still there when you come back.
  const [visited, setVisited] = useState<ReadonlySet<SpaceId>>(new Set<SpaceId>(["chat"]));
  const bridge = useRef(newBridge());
  // A space that is not on screen writes here instead, so it cannot overwrite the shortcuts of the visible one.
  const inactiveBridge = useRef(newBridge());
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(emptyWorkspace);
  const [boot, setBoot] = useState<LoadState>({ kind: "loading" });
  const [providers, setProviders] = useState<ProviderDescriptor[] | null>(null);
  const [preferredProvider, setPreferredProvider] = useState<ProviderKind | null>(readStoredProvider);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { theme, toggleTheme } = useThemeMode();

  const loadWorkspace = useCallback(() => {
    setBoot({ kind: "loading" });
    return workspaceBootstrap()
      .then((snapshot) => {
        setWorkspace(snapshot);
        setBoot({ kind: "ready" });
      })
      .catch((err: unknown) => setBoot({ kind: "failed", message: errorMessage(err) }));
  }, []);

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
      .catch(() => {
        if (!cancelled) {
          setProviders([]);
        }
      });
    void loadWorkspace();
    return () => {
      cancelled = true;
    };
  }, [loadWorkspace]);

  useEffect(() => {
    setVisited((current) => (current.has(space) ? current : new Set([...current, space])));
  }, [space]);

  const overlayOpen = sessionsOpen || btwOpen || artifactsOpen || legendOpen || settingsOpen;
  const hasChat = workspace.sessions.some((item) => item.id === workspace.selected_session_id);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = resolveShortcut(event, { space, overlay: overlayOpen });
      if (!action) {
        return;
      }
      event.preventDefault();
      switch (action.type) {
        case "space":
          setSpace((current) => nextSpace(current, action.delta));
          break;
        case "terminal":
          setTerminalOpen((openPanel) => !openPanel);
          break;
        case "btw":
          openBtw(null);
          break;
        case "artifacts":
          setArtifactsOpen((open) => !open);
          break;
        case "legend":
          setLegendOpen(true);
          break;
        case "version":
          bridge.current.commands.version?.();
          break;
        case "item":
          bridge.current.commands.item?.(action.delta);
          break;
        case "comment":
          bridge.current.commands.comment?.();
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space, overlayOpen, hasChat]);

  function openBtw(resume: BtwTask | null) {
    if (!hasChat && !resume) {
      setError("Open or start a chat first: a BTW question attaches to a chat.");
      return;
    }
    setBtwResume(resume);
    setBtwOpen(true);
  }

  function openInCode(path: string, line: number | null) {
    setCodeRequest((current) => ({ path, line, n: (current?.n ?? 0) + 1 }));
    setSpace("code");
  }

  const selectedSession = useMemo(
    () =>
      workspace.sessions.find(
        (item) => item.id === workspace.selected_session_id,
      ) ?? null,
    [workspace],
  );

  const choices = useMemo(
    () => visibleProviders(providers ?? [], selectedSession?.provider ?? null, import.meta.env.DEV),
    [providers, selectedSession?.provider],
  );
  const provider = pickProvider(choices, preferredProvider);

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

  // Every local branch, read from git when the selector opens and when the worktree changes.
  const [branches, setBranches] = useState<BranchView[]>([]);
  const worktreeId = selectedWorktree?.id ?? null;
  const refreshBranches = useCallback(async () => {
    if (!worktreeId) {
      setBranches([]);
      return;
    }
    try {
      const list = await workspaceListBranches(worktreeId);
      setBranches(list.branches);
      // The branch label of each worktree may have moved under us (a checkout outside the app).
      setWorkspace((current) =>
        sameBranches(current, list.workspace) ? current : { ...current, worktrees: list.workspace.worktrees },
      );
    } catch {
      // The selector still shows the current branch; the list is read again next time it opens.
    }
  }, [worktreeId]);
  useEffect(() => {
    void refreshBranches();
  }, [refreshBranches]);
  // The app follows git: a branch switched in a terminal (or by another tool) is switched here too.
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void listen("workspace://changed", () => void refreshBranches()).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        stop = unlisten;
      }
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [refreshBranches]);
  const currentBranch = selectedWorktree?.branch ?? "";
  // The reference this chat's branch is compared against. It is remembered per chat.
  const [storedReference, setStoredReference] = useState("");
  const chatId = selectedSession?.id ?? null;
  useEffect(() => {
    setStoredReference(readReference(chatId));
  }, [chatId]);
  function setReference(next: string) {
    setStoredReference(next);
    if (chatId) {
      try {
        window.localStorage.setItem(`ataraxia.compareWith.${chatId}`, next);
      } catch {
        // Not remembering the choice is harmless.
      }
    }
  }
  const reference = storedReference === currentBranch ? "" : storedReference;
  const branchOptions = useMemo(() => {
    const listed = branches.map((branch) => ({
      value: branch.name,
      label: branch.name,
      hint:
        branch.worktree_id && !branch.current
          ? "open in another worktree"
          : undefined,
    }));
    return listed.some((item) => item.value === currentBranch) || !currentBranch
      ? listed
      : [{ value: currentBranch, label: currentBranch, hint: undefined }, ...listed];
  }, [branches, currentBranch]);

  // With a chat open the selector shows (and changes) that chat's provider; otherwise it picks
  // the provider for the next new chat.
  const shownProvider: ProviderKind | null = selectedSession?.provider ?? provider;

  async function onProviderSwitch(next: ProviderKind) {
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
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runWorkspace(
    action: () => Promise<WorkspaceSnapshot>,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setWorkspace(await action());
    } catch (err) {
      setError(errorMessage(err));
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
    if (!provider) {
      setError("No coding agent is available. Install Claude Code, Codex or OpenCode first.");
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
  const canCreate = Boolean(selectedRepository && selectedWorktree && provider) && !busy;

  const sessionId = selectedSession?.id ?? null;
  const activity = useSessionActivity(sessionId);
  const failedArtifacts = useFailedArtifacts(sessionId);

  function chatSpace() {
    if (boot.kind === "loading") {
      return <StateMessage text="Opening your workspace…" tone="loading" />;
    }
    if (boot.kind === "failed") {
      return (
        <StateMessage text={`The workspace did not open: ${boot.message}`} tone="failed">
          <Button variant="secondary" onClick={() => void loadWorkspace()}>
            Try again
          </Button>
        </StateMessage>
      );
    }
    if (selectedSession) {
      return (
        <ChatPanel
          key={selectedSession.id}
          contextLabel={contextLabel}
          provider={providers?.find((item) => item.kind === selectedSession.provider) ?? null}
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
      );
    }
    return (
      <NewContext
        busy={busy}
        canCreate={canCreate}
        contextLabel={contextLabel}
        hasRepository={Boolean(selectedRepository)}
        providerLabel={provider ? PROVIDER_LABELS[provider] : null}
        providers={providers === null ? null : choices}
        onNewChat={() => {
          void onNewChat();
        }}
        onOpenRepository={() => {
          void onOpenRepository();
        }}
      />
    );
  }

  return (
    <div className="relative flex h-full flex-col bg-cg-panel text-cg-ink">
      <header className="flex h-[61px] flex-none items-center justify-between gap-4 border-b border-cg-line px-8.5">
        <div className="flex min-w-0 items-center gap-2.5 text-ui font-semibold whitespace-nowrap">
          <BrandMark />
          {workspace.repositories.length === 0 ? (
            <button
              className="rounded-cg-sm py-1.5 text-cg-ink hover:text-cg-accent"
              disabled={busy || boot.kind !== "ready"}
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

          <span aria-hidden="true" className="text-cg-control">
            /
          </span>

          <QuietSelect
            aria-label="Branch"
            className="max-w-[175px] text-ui font-medium text-cg-muted-strong"
            disabled={!selectedRepository || !selectedWorktree || busy}
            options={branchOptions}
            placeholder="branch"
            searchable
            title="Branch of this worktree. Choosing another one switches to it, and says why if git refuses."
            value={currentBranch}
            onChange={(value) => {
              if (selectedWorktree && value !== currentBranch) {
                void runWorkspace(() => workspaceSelectBranch(selectedWorktree.id, value));
              }
            }}
            onOpen={() => void refreshBranches()}
          />

          <ReferenceSelect
            currentBranch={currentBranch}
            sessionId={selectedSession?.id ?? null}
            value={reference}
            onChange={setReference}
          />

          <span aria-hidden="true" className="text-cg-control">
            /
          </span>
          <span>{spaceLabel}</span>
        </div>

        <div className="flex flex-none items-center gap-2">
          {activity.needsApproval && space !== "chat" ? (
            <Button variant="quiet" onClick={() => setSpace("chat")}>
              <ShieldAlert aria-hidden="true" className="text-cg-amber-text" size={14} />
              Agent needs approval
            </Button>
          ) : activity.status === "working" && space !== "chat" ? (
            <Chip icon={<Loader2 aria-hidden="true" className="animate-spin" size={12} />}>Agent working</Chip>
          ) : null}

          <QuietSelect
            aria-label="Provider"
            className="max-w-[130px] text-small text-cg-muted-strong"
            disabled={busy || choices.length === 0}
            options={choices.map((item) => ({
              value: item.kind,
              label: `${item.display_name}${item.available ? "" : " (unavailable)"}`,
              disabled: !item.available,
              hint: item.detail ?? undefined,
            }))}
            placeholder="No agent found"
            title={selectedSession ? "Provider for this chat" : "Provider for new chats"}
            value={shownProvider ?? ""}
            onChange={(value) => {
              void onProviderSwitch(value as ProviderKind);
            }}
          />

          <Tip label="New chat">
            <Button
              aria-label="New chat"
              disabled={!canCreate}
              variant="icon"
              onClick={() => {
                void onNewChat();
              }}
            >
              <Plus size={16} />
            </Button>
          </Tip>
          <Tip label="Sessions in this repository">
            <Button
              aria-label="Sessions in this repository"
              aria-pressed={sessionsOpen}
              data-sessions-toggle
              disabled={!selectedRepository}
              variant="icon"
              onClick={() => setSessionsOpen((current) => !current)}
            >
              <MessageCircle size={16} />
            </Button>
          </Tip>
          <Tip label="Artifacts of this chat (Shift A)">
            <Button
              aria-label={`Artifacts of this chat${failedArtifacts > 0 ? `, ${failedArtifacts} failed` : ""}`}
              className="relative"
              disabled={!selectedSession}
              variant="icon"
              onClick={() => setArtifactsOpen(true)}
            >
              <Layers size={16} />
              {failedArtifacts > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-cg-red px-1 text-small leading-none font-semibold text-cg-on-primary"
                >
                  {failedArtifacts}
                </span>
              ) : null}
            </Button>
          </Tip>
          <Tip label="Terminal (Ctrl/⌘ J)">
            <Button
              aria-label="Toggle terminal"
              aria-pressed={terminalOpen}
              disabled={!selectedWorktree}
              variant="icon"
              onClick={() => setTerminalOpen((openPanel) => !openPanel)}
            >
              <TerminalSquare size={16} />
            </Button>
          </Tip>
          <Tip label="Keyboard shortcuts (?)">
            <Button aria-label="Keyboard shortcuts" variant="icon" onClick={() => setLegendOpen(true)}>
              <Keyboard size={16} />
            </Button>
          </Tip>
          <Tip label="Settings">
            <Button aria-label="Settings" variant="icon" onClick={() => setSettingsOpen(true)}>
              <Settings size={16} />
            </Button>
          </Tip>
          <Tip label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}>
            <Button aria-label="Toggle theme" variant="icon" onClick={toggleTheme}>
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </Button>
          </Tip>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 pr-10.5">
        {space === "chat" ? <ErrorBoundary label="Chat">{chatSpace()}</ErrorBoundary> : null}

        {visited.has("code") ? (
          <div className={space === "code" ? "h-full" : "hidden"}>
            <ErrorBoundary label="Code">
              <CodeSpace
                bridge={space === "code" ? bridge : inactiveBridge}
                dark={theme === "dark"}
                openRequest={codeRequest}
                reference={reference || null}
                session={selectedSession}
                worktree={selectedWorktree}
                onBtw={() => openBtw(null)}
                onError={setError}
              />
            </ErrorBoundary>
          </div>
        ) : null}
        {visited.has("decisions") ? (
          <div className={space === "decisions" ? "h-full" : "hidden"}>
            <ErrorBoundary label="Decisions">
              <DecisionsSpace
                bridge={space === "decisions" ? bridge : inactiveBridge}
                session={selectedSession}
                onError={setError}
                onOpenFile={openInCode}
              />
            </ErrorBoundary>
          </div>
        ) : null}
        {visited.has("flow") ? (
          <div className={space === "flow" ? "h-full" : "hidden"}>
            <ErrorBoundary label="Flow">
              <FlowSpace
                bridge={space === "flow" ? bridge : inactiveBridge}
                dark={theme === "dark"}
                session={selectedSession}
                onError={setError}
                onOpenFile={openInCode}
              />
            </ErrorBoundary>
          </div>
        ) : null}

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
      <BtwPalette
        isOpen={btwOpen}
        item={bridge.current.context}
        providers={providers ?? []}
        resume={btwResume}
        session={selectedSession}
        space={space}
        onClose={() => {
          setBtwOpen(false);
          setBtwResume(null);
        }}
        onError={setError}
      />
      <ArtifactsDrawer
        isOpen={artifactsOpen}
        session={selectedSession}
        onClose={() => setArtifactsOpen(false)}
        onError={setError}
        onNavigate={setSpace}
        onOpenBtw={(task) => openBtw(task)}
      />
      <ShortcutLegend isOpen={legendOpen} onClose={() => setLegendOpen(false)} />
      <SettingsDialog
        isOpen={settingsOpen}
        provider={selectedSession?.provider ?? null}
        repository={selectedRepository}
        onClose={() => setSettingsOpen(false)}
        onError={setError}
      />
      <Toast message={error} onDismiss={() => setError(null)} />
    </div>
  );
}
