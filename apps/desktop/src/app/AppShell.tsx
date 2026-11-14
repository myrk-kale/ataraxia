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
import { codeRepoChanges, type BtwTask, type RepoChanges } from "../lib/insights";
import { useInsightEvents } from "../lib/useInsightEvents";
import { NewContext } from "../chat/NewContext";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { QuietSelect } from "../ui/QuietSelect";
import { ReferenceSelect } from "./ReferenceSelect";
import { RepositorySelect } from "./RepositorySelect";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { Tip } from "../ui/Overlay";
import { StateMessage, type LoadState } from "../ui/State";
import {
  emptyWorkspace,
  workspaceBootstrap,
  workspaceCreateSession,
  workspaceOpenRepository,
  workspaceDeleteSession,
  workspaceOpenSession,
  workspaceSelectRepository,
  workspaceSelectWorkspace,
  workspaceListBranches,
  workspaceSelectBranch,
  type BranchView,
  type ProviderKind,
  type RepositoryId,
  type WorkspaceSnapshot,
} from "../lib/workspace";
import { ArtifactsDrawer } from "./ArtifactsDrawer";
import { EdgeNav } from "./EdgeNav";
import { play, watchForTouch } from "./sound/sound";
import { SessionsPanel } from "./SessionsPanel";
import { SettingsDialog } from "./SettingsDialog";
import { ShortcutLegend } from "./ShortcutLegend";
import { Toast } from "./Toast";
import { activeItem, newBridge, otherItems, type SpaceBridges } from "./spaceCommands";
import { isSpaceKey, resolveShortcut } from "./shortcuts";
import { TRAFFIC_LIGHTS_INSET, useTitlebarInset } from "./titlebar";
import { referenceKey, resolveFileRef, selectedWorkspace } from "./workspaceView";
import { nextSpace, SPACES, type SpaceId } from "./spaces";
import { pickProvider, visibleProviders } from "./providers";
import { useAppearance } from "./appearance/store";
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

/** A deleted chat leaves no remembered comparisons behind. */
function forgetComparisons(chatId: string) {
  try {
    const prefix = `ataraxia.compareWith.${chatId}`;
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) {
        keys.push(key);
      }
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Storage can be unavailable; a stale entry is harmless.
  }
}

/**
 * The comparison remembered for one repository of a chat. A chat made before workspaces kept one
 * for the whole chat, which belongs to the chat's own repository.
 */
function readReference(chatId: string | null, repositoryId: string | null, ownRepositoryId: string | null): string {
  if (!chatId || !repositoryId) {
    return "";
  }
  try {
    const stored = window.localStorage.getItem(referenceKey(chatId, repositoryId));
    if (stored !== null) {
      return stored;
    }
    return repositoryId === ownRepositoryId ? (window.localStorage.getItem(`ataraxia.compareWith.${chatId}`) ?? "") : "";
  } catch {
    return "";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function AppShell() {
  const [space, setSpace] = useState<SpaceId>("chat");

  // Changing space ticks, whether by the dots, the keyboard or the wheel.
  useEffect(() => watchForTouch(), []);
  const shownSpace = useRef(space);
  useEffect(() => {
    if (shownSpace.current !== space) {
      shownSpace.current = space;
      play("tick");
    }
  }, [space]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [btwOpen, setBtwOpen] = useState(false);
  const [btwResume, setBtwResume] = useState<BtwTask | null>(null);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The workspace dialog: a new workspace, or the one on screen.
  const [workspaceDialog, setWorkspaceDialog] = useState<"new" | "edit" | null>(null);
  const [codeRequest, setCodeRequest] = useState<{ path: string; line: number | null; n: number } | null>(null);
  // Spaces stay mounted once visited, so the open file, the selected decision and the diagram
  // are still there when you come back.
  const [visited, setVisited] = useState<ReadonlySet<SpaceId>>(new Set<SpaceId>(["chat"]));
  // Each space writes into its own bridge: the visible one answers the shortcuts, and BTW reads what
  // every space has open, whichever one it was summoned from.
  const codeBridge = useRef(newBridge());
  const decisionsBridge = useRef(newBridge());
  const flowBridge = useRef(newBridge());
  const bridges: SpaceBridges = {
    code: codeBridge.current,
    decisions: decisionsBridge.current,
    flow: flowBridge.current,
  };
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(emptyWorkspace);
  const [boot, setBoot] = useState<LoadState>({ kind: "loading" });
  const [providers, setProviders] = useState<ProviderDescriptor[] | null>(null);
  const [preferredProvider, setPreferredProvider] = useState<ProviderKind | null>(readStoredProvider);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { kind: theme, toggleKind: toggleTheme } = useAppearance();
  // The header is the window's title bar on macOS: it makes room for the window buttons.
  const titlebarInset = useTitlebarInset();

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
  // A dialog a view opens by itself (a diagram full screen) owns the keyboard as well.
  const anOverlay = () => overlayOpen || document.querySelector("dialog[open]") !== null;
  const hasChat = workspace.sessions.some((item) => item.id === workspace.selected_session_id);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = resolveShortcut(event, { space, overlay: anOverlay() });
      if (!action) {
        return;
      }
      event.preventDefault();
      const current = space === "code" ? codeBridge.current : space === "decisions" ? decisionsBridge.current : space === "flow" ? flowBridge.current : null;
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
          current?.commands.version?.();
          break;
        case "item":
          current?.commands.item?.(action.delta);
          break;
        case "comment":
          current?.commands.comment?.();
          break;
        case "wrap":
          current?.commands.wrap?.();
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space, overlayOpen, hasChat]);

  // Shift+Up/Down changes space whatever has focus. The editor and the terminal handle their keys
  // before the page sees them, so this one listens first and keeps the key from reaching them.
  useEffect(() => {
    function onSpaceKey(event: KeyboardEvent) {
      if (!isSpaceKey(event)) {
        return;
      }
      const action = resolveShortcut(event, { space, overlay: anOverlay() });
      if (action?.type !== "space") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSpace((current) => nextSpace(current, action.delta));
    }
    window.addEventListener("keydown", onSpaceKey, true);
    return () => window.removeEventListener("keydown", onSpaceKey, true);
  }, [space, overlayOpen]);

  function openBtw(resume: BtwTask | null) {
    if (!hasChat && !resume) {
      setError("Open or start a chat first: a BTW question attaches to a chat.");
      return;
    }
    setBtwResume(resume);
    setBtwOpen(true);
  }

  // A path a chat named is the chat's own repository's, or `<repository>/<path>` for another member.
  // Opening one in another repository puts that repository in focus first.
  async function openInCode(path: string, line: number | null) {
    const target = resolveFileRef(path, selectedSession?.repository_id ?? null, members);
    if (target.repositoryId && target.repositoryId !== workspace.selected_repository_id) {
      setBusy(true);
      try {
        setWorkspace(await workspaceSelectRepository(target.repositoryId));
      } catch (err) {
        setError(errorMessage(err));
        return;
      } finally {
        setBusy(false);
      }
    }
    setCodeRequest((current) => ({ path: target.path, line, n: (current?.n ?? 0) + 1 }));
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

  const inWorkspace = useMemo(() => selectedWorkspace(workspace), [workspace]);
  const members = useMemo(() => inWorkspace?.members ?? [], [inWorkspace]);
  // With one repository the app looks exactly as it always did; the repository selector, the
  // counts and the labels that name a repository only appear from two.
  const multi = members.length > 1;
  const repositoryNames = useMemo(
    () => (multi ? Object.fromEntries(members.map((item) => [item.id, item.name])) : undefined),
    [multi, members],
  );

  // What the agent changed in each repository of the workspace, for the repository selector.
  const [changes, setChanges] = useState<RepoChanges[]>([]);
  const refreshChanges = useCallback(() => {
    const id = selectedSession?.id ?? null;
    if (!multi || !id) {
      setChanges([]);
      return;
    }
    codeRepoChanges(id)
      .then(setChanges)
      .catch(() => setChanges([]));
  }, [multi, selectedSession?.id]);
  useEffect(() => {
    refreshChanges();
  }, [refreshChanges, space]);
  useInsightEvents((event) => {
    if (event.type === "checkpoint" && event.sessionId === selectedSession?.id) {
      refreshChanges();
    }
  });

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
  const focusRepositoryId = selectedRepository?.id ?? null;
  const ownRepositoryId = selectedSession?.repository_id ?? null;
  useEffect(() => {
    setStoredReference(readReference(chatId, focusRepositoryId, ownRepositoryId));
  }, [chatId, focusRepositoryId, ownRepositoryId]);
  function setReference(next: string) {
    setStoredReference(next);
    if (chatId && focusRepositoryId) {
      try {
        window.localStorage.setItem(referenceKey(chatId, focusRepositoryId), next);
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

  const selectRepository = useCallback(
    (id: RepositoryId) => {
      void runWorkspace(() => workspaceSelectRepository(id));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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
      {/* The empty parts of the header move the window, as a title bar does. Controls stay clickable. */}
      <header
        className="flex h-[61px] flex-none items-center justify-between gap-4 border-b border-cg-line pr-8.5 pl-8.5"
        data-tauri-drag-region
        style={titlebarInset ? { paddingLeft: TRAFFIC_LIGHTS_INSET } : undefined}
      >
        <div className="flex min-w-0 items-center gap-2.5 text-ui font-semibold whitespace-nowrap" data-tauri-drag-region>
          {workspace.workspaces.length === 0 ? (
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
            <>
              <QuietSelect
                aria-label="Workspace"
                actions={[
                  { label: "Open folder…", onSelect: () => void onOpenRepository() },
                  { label: "New workspace…", onSelect: () => setWorkspaceDialog("new") },
                  { label: "Edit this workspace…", onSelect: () => setWorkspaceDialog("edit") },
                ]}
                className="max-w-[210px] text-ui font-semibold text-cg-ink"
                disabled={busy}
                options={workspace.workspaces.map((item) => ({
                  value: item.id,
                  label: item.repository_ids.length > 1 ? `${item.name} · ${item.repository_ids.length} repositories` : item.name,
                  display: item.name,
                }))}
                sound
                title="The workspace: its chats, and the repositories their agents can see"
                value={workspace.selected_workspace_id ?? ""}
                onChange={(value) => {
                  void runWorkspace(() => workspaceSelectWorkspace(value));
                }}
              />
              {multi ? (
                <>
                  <span aria-hidden="true" className="text-cg-control">
                    /
                  </span>
                  <RepositorySelect
                    changes={changes}
                    className="max-w-[210px] text-ui font-semibold text-cg-ink"
                    compact
                    disabled={busy}
                    repositories={members}
                    value={workspace.selected_repository_id}
                    onChange={selectRepository}
                  />
                </>
              ) : null}
            </>
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
            repositoryId={focusRepositoryId}
            sessionId={selectedSession?.id ?? null}
            value={reference}
            onChange={setReference}
          />

          <span aria-hidden="true" className="text-cg-control">
            /
          </span>
          <span>{spaceLabel}</span>
        </div>

        <div className="flex flex-none items-center gap-2" data-tauri-drag-region>
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
            sound
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
          <Tip label={multi ? "Sessions in this workspace" : "Sessions in this repository"}>
            <Button
              aria-label={multi ? "Sessions in this workspace" : "Sessions in this repository"}
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
          <Tip label="Terminal (Ctrl/⌘ `)">
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

      {/* The dots float over the diagram; every other space leaves them a gutter. */}
      <div className={`relative min-h-0 flex-1 ${space === "flow" ? "" : "pr-10.5"}`}>
        {space === "chat" ? <ErrorBoundary label="Chat">{chatSpace()}</ErrorBoundary> : null}

        {visited.has("code") ? (
          <div className={space === "code" ? "h-full" : "hidden"}>
            <ErrorBoundary label="Code">
              <CodeSpace
                bridge={codeBridge}
                openRequest={codeRequest}
                reference={reference || null}
                changes={changes}
                repositories={members}
                session={selectedSession}
                worktree={selectedWorktree}
                onReviewChanged={refreshChanges}
                onSelectRepository={selectRepository}
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
                bridge={decisionsBridge}
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
                bridge={flowBridge}
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
            repositoryNames={repositoryNames}
            sessions={workspace.sessions}
            worktrees={workspace.worktrees}
            onClose={closeSessions}
            onDelete={(id) => {
              forgetComparisons(id);
              void runWorkspace(() => workspaceDeleteSession(id));
            }}
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
          label={multi ? selectedRepository?.name : undefined}
          worktreeId={selectedWorktree.id}
          onClose={() => setTerminalOpen(false)}
        />
      ) : null}

      <EdgeNav space={space} onSelect={setSpace} />
      <BtwPalette
        isOpen={btwOpen}
        item={activeItem(bridges, space)}
        others={otherItems(bridges, space)}
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
        onClose={() => setSettingsOpen(false)}
      />
      <WorkspaceDialog
        isOpen={workspaceDialog !== null}
        repositories={workspace.repositories}
        workspace={workspaceDialog === "edit" ? (inWorkspace?.workspace ?? null) : null}
        onClose={() => setWorkspaceDialog(null)}
        onSaved={setWorkspace}
      />
      <Toast message={error} onDismiss={() => setError(null)} />
    </div>
  );
}
