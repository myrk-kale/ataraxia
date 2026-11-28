import {
  Keyboard,
  Layers,
  ListTodo,
  Loader2,
  MessageCircle,
  Moon,
  Network,
  Plus,
  Search,
  Server,
  Settings,
  ShieldAlert,
  Sun,
  TerminalSquare,
  Users,
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
import { DecisionsReview } from "../decisions/DecisionsReview";
import { FlowSpace } from "../flow/FlowSpace";
import { useWorkbench } from "../workbench/useWorkbench";
import { WorkbenchSpace } from "../workbench/WorkbenchSpace";
import { BrowserNotice } from "../browser/BrowserNotice";
import { BrowserPictureInPicture } from "../browser/BrowserPictureInPicture";
import { browserActivate } from "../lib/browser";
import { Onboarding } from "../onboarding/Onboarding";
import { Companion } from "../pet/Companion";
import type { TabId as SettingsTab } from "./SettingsDialog";
import { shouldShowOnboarding } from "../onboarding/store";
import { BrowserSpace } from "../browser/BrowserSpace";
import { TasksDrawer } from "../tasks/TasksDrawer";
import { MemoryGraph } from "../memory/MemoryGraph";
import { btwList, codeRepoChanges, type BtwTask, type RepoChanges } from "../lib/insights";
import { isSearchReview, type ConversationJump, type SearchResult } from "../lib/search";
import { useInsightEvents } from "../lib/useInsightEvents";
import { NewContext } from "../chat/NewContext";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { QuietSelect } from "../ui/QuietSelect";
import { RepositorySelect } from "./RepositorySelect";
import { NewBranchDialog } from "./NewBranchDialog";
import { GoToBranchDialog } from "./GoToBranchDialog";
import { GlobalSearch } from "./GlobalSearch";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { McpServersDialog } from "./McpServersDialog";
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
  workspaceSelectWorktree,
  workspacePreviousWorkspace,
  workspaceListBranches,
  workspaceSelectBranch,
  workspaceCheckoutRemoteBranch,
  workspaceCreateBranch,
  workspaceFetchBranches,
  workspaceGoToBranch,
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
import { UpdatePrompt } from "./UpdatePrompt";
import { activeItem, newBridge, otherItems, type SpaceBridges } from "./spaceCommands";
import { isSearchKey, isSpaceKey, resolveShortcut } from "./shortcuts";
import { TRAFFIC_LIGHTS_INSET, useTitlebarInset } from "./titlebar";
import { referenceKey, resolveFileRef, selectedWorkspace } from "./workspaceView";
import type { BranchTarget } from "./branchLink";
import { nextSpace, SPACES, type SpaceId } from "./spaces";
import { pickProvider, visibleProviders } from "./providers";
import { useAppearance } from "./appearance/store";
import { useFailedArtifacts, useSessionActivity } from "./useSessionActivity";
import { forgetDraft, keepNewChatText, loadDraft, saveDraft, takeNewChatText } from "../chat/draftStore";
import { forgetClosedSubagents } from "../chat/closedSubagents";
import { DRAFT_SETTLED_EVENT, draftChats, markDraftChat, settleDraftChat } from "../chat/draftChats";

const PROVIDER_STORAGE_KEY = "ataraxia.newChatProvider";

function readStoredProvider(): ProviderKind | null {
  try {
    const stored = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (stored === "opencode" || stored === "claude" || stored === "codex" || stored === "cursor") {
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

/** Marks an option of the branch selector as a remote branch, so choosing it makes a local one. */
const REMOTE_PREFIX = "remote:";

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
  const [mcpOpen, setMcpOpen] = useState(false);
  const [goToBranchOpen, setGoToBranchOpen] = useState(false);
  const [btwOpen, setBtwOpen] = useState(false);
  const [btwPrivate, setBtwPrivate] = useState(false);
  const [btwResume, setBtwResume] = useState<BtwTask | null>(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<SearchResult | null>(null);
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  // Chats made with + that have had no message yet: kept out of the chat list.
  const [drafts, setDrafts] = useState<ReadonlySet<string>>(draftChats);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  // After the opening animation: every dev start, otherwise only for an unseen tour version.
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    if (!import.meta.env.DEV && !shouldShowOnboarding()) {
      return;
    }
    const root = document.documentElement;
    const open = () => {
      if (!root.hasAttribute("data-intro-running")) {
        setTourOpen(true);
        observer.disconnect();
      }
    };
    const observer = new MutationObserver(open);
    observer.observe(root, { attributes: true, attributeFilter: ["data-intro-running"] });
    open();
    return () => observer.disconnect();
  }, []);
  // The workspace dialog: a new workspace, or the one on screen.
  const [workspaceDialog, setWorkspaceDialog] = useState<"new" | "edit" | null>(null);
  const [codeRequest, setCodeRequest] = useState<{ path: string; line: number | null; endLine: number | null; n: number; checkpointId?: string } | null>(null);
  // Spaces stay mounted once visited, so the open file, the selected decision and the diagram
  // are still there when you come back.
  const [visited, setVisited] = useState<ReadonlySet<SpaceId>>(new Set<SpaceId>(["chat"]));
  // Each space writes into its own bridge: the visible one answers the shortcuts, and BTW reads what
  // every space has open, whichever one it was summoned from.
  const codeBridge = useRef(newBridge());
  const flowBridge = useRef(newBridge());
  const bridges: SpaceBridges = {
    code: codeBridge.current,
    flow: flowBridge.current,
  };
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(emptyWorkspace);
  const companionChats = useMemo(
    () => [...workspace.sessions.filter((item) => !drafts.has(item.id)), ...(workspace.other_sessions ?? [])].map((item) => ({ id: item.id, title: item.title })),
    [workspace.sessions, workspace.other_sessions, drafts],
  );
  // The agents on the workbench, read here so the nav can say when something waits for the developer.
  const board = useWorkbench(workspace.selected_workspace_id, space === "workbench");
  const workbenchNeeds = board.view?.needsYou.length ?? 0;
  const workbenchChats = useMemo(
    () => workspace.sessions.filter((item) => (item.kind ?? "chat") === "chat"),
    [workspace.sessions],
  );
  const [boot, setBoot] = useState<LoadState>({ kind: "loading" });
  const [providers, setProviders] = useState<ProviderDescriptor[] | null>(null);
  const [preferredProvider, setPreferredProvider] = useState<ProviderKind | null>(readStoredProvider);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { kind: theme, toggleKind: toggleTheme } = useAppearance();
  // The header is the window's title bar on macOS: it makes room for the window buttons.
  const titlebarInset = useTitlebarInset();
  const [meterSlot, setMeterSlot] = useState<HTMLElement | null>(null);

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

  const overlayOpen =
    sessionsOpen ||
    btwOpen ||
    artifactsOpen ||
    tasksOpen ||
    memoryOpen ||
    searchOpen ||
    decisionsOpen ||
    legendOpen ||
    settingsOpen ||
    tourOpen ||
    mcpOpen ||
    goToBranchOpen;
  // A dialog a view opens by itself (a diagram full screen) owns the keyboard as well.
  const anOverlay = () => overlayOpen || document.querySelector("dialog[open], [role='dialog'][aria-modal='true']") !== null;
  const hasChat = workspace.sessions.some((item) => item.id === workspace.selected_session_id);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = resolveShortcut(event, { space, overlay: anOverlay() });
      if (!action) {
        return;
      }
      event.preventDefault();
      const current = space === "code" ? codeBridge.current : space === "flow" ? flowBridge.current : null;
      switch (action.type) {
        case "space":
          setSpace((current) => nextSpace(current, action.delta));
          break;
        case "terminal":
          setTerminalOpen((openPanel) => !openPanel);
          break;
        case "previous-workspace":
          void runWorkspace(workspacePreviousWorkspace);
          break;
        case "btw":
          openBtw(null, action.private);
          break;
        case "tasks":
          setTasksOpen((open) => !open);
          break;
        case "memory":
          setMemoryOpen((open) => !open);
          break;
        case "browser":
          setSpace((current) => (current === "browser" ? "chat" : "browser"));
          break;
        case "workbench":
          setSpace((current) => (current === "workbench" ? "chat" : "workbench"));
          break;
        case "search":
          setSearchOpen(true);
          break;
        case "branch":
          if (selectedWorktree) {
            setGoToBranchOpen(true);
          } else {
            setError("Open a repository first.");
          }
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

  // The editor and terminal handle their keys before the page sees them.
  useEffect(() => {
    function onGlobalKey(event: KeyboardEvent) {
      if (!isSpaceKey(event) && !isSearchKey(event)) {
        return;
      }
      const action = resolveShortcut(event, { space, overlay: anOverlay() });
      if (action?.type !== "space" && action?.type !== "search") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (action.type === "search") {
        setSearchOpen(true);
      } else {
        setSpace((current) => nextSpace(current, action.delta));
      }
    }
    window.addEventListener("keydown", onGlobalKey, true);
    return () => window.removeEventListener("keydown", onGlobalKey, true);
  }, [space, overlayOpen]);

  function openBtw(resume: BtwTask | null, privately = false) {
    if (!hasChat && !resume) {
      setError("Open or start a chat first: a BTW question attaches to a chat.");
      return;
    }
    setBtwResume(resume);
    setBtwPrivate(privately);
    setBtwOpen(true);
  }

  // A path a chat named is the chat's own repository's, or `<repository>/<path>` for another member.
  // Opening one in another repository puts that repository in focus first.
  async function openInCode(path: string, line: number | null, endLine: number | null = null) {
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
    setCodeRequest((current) => ({ path: target.path, line, endLine, n: (current?.n ?? 0) + 1 }));
    setSpace("code");
  }

  // A chat the workbench names: open it in the chat space.
  function openChat(id: string) {
    void runWorkspace(async () => {
      const snapshot = await workspaceOpenSession(id);
      setSpace("chat");
      return snapshot;
    });
  }

  // Files named in the chat open through a function that never changes, so messages are not
  // drawn again each time this component is.
  const openInCodeRef = useRef(openInCode);
  openInCodeRef.current = openInCode;
  const openCite = useCallback(
    (cite: { path: string; line: number | null; endLine: number | null }) =>
      void openInCodeRef.current(cite.path, cite.line, cite.endLine),
    [],
  );

  const selectedSession = useMemo(
    () =>
      workspace.sessions.find(
        (item) => item.id === workspace.selected_session_id,
      ) ?? null,
    [workspace],
  );

  const conversationJump = useMemo<ConversationJump | undefined>(() => {
    if (!searchTarget || searchTarget.sessionId !== selectedSession?.id) {
      return undefined;
    }
    if (searchTarget.kind === "message") {
      return { messageId: searchTarget.itemId };
    }
    if (searchTarget.kind === "subagent") {
      return { subagentId: searchTarget.itemId };
    }
    return undefined;
  }, [searchTarget, selectedSession?.id]);

  async function openSearchResult(result: SearchResult) {
    if (result.kind === "task") {
      setSearchTarget(result);
      setTasksOpen(true);
      return;
    }
    if (!result.sessionId) {
      throw new Error("This result has no conversation to open.");
    }
    const task = result.btwId
      ? (await btwList(result.sessionId)).find((item) => item.id === result.btwId)
      : null;
    if (result.btwId && !task) {
      throw new Error("This BTW is no longer available.");
    }
    let snapshot = await workspaceOpenSession(result.sessionId);
    const review = isSearchReview(result);
    if (review && result.worktreeId && result.worktreeId !== snapshot.selected_worktree_id) {
      snapshot = await workspaceSelectWorktree(result.worktreeId);
    }
    setWorkspace(snapshot);
    setSearchTarget(result);
    if (review) {
      if (result.path) {
        const path = result.path;
        setCodeRequest((current) => ({
          path, line: result.line, endLine: null, n: (current?.n ?? 0) + 1,
          checkpointId: result.checkpointId ?? undefined,
        }));
      }
      setSpace("code");
    } else if (result.kind === "flow") {
      setSpace("flow");
    } else {
      setSpace("chat");
      if (task) {
        openBtw(task);
      } else if (result.kind === "decision" || result.kind === "decision_item") {
        setDecisionsOpen(true);
      }
    }
  }

  async function openMcpSession(sessionId: string) {
    setWorkspace(await workspaceOpenSession(sessionId));
    setSpace("chat");
  }

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
  const memoryWorkspaces = useMemo(
    () => workspace.workspaces.map((item) => ({ id: item.id, name: item.name })),
    [workspace.workspaces],
  );
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
    // A new chat is named once its first exchange is over.
    if (event.type === "sessionTitle") {
      setWorkspace((current) => ({
        ...current,
        sessions: current.sessions.map((item) =>
          item.id === event.sessionId ? { ...item, title: event.title } : item,
        ),
      }));
    }
  });

  // Every local branch, read from git when the selector opens and when the worktree changes.
  const [branches, setBranches] = useState<BranchView[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const worktreeId = selectedWorktree?.id ?? null;
  const refreshBranches = useCallback(async () => {
    if (!worktreeId) {
      setBranches([]);
      setRemoteBranches([]);
      return;
    }
    try {
      const list = await workspaceListBranches(worktreeId);
      setBranches(list.branches);
      setRemoteBranches(list.remotes ?? []);
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
    if (searchTarget && isSearchReview(searchTarget)) {
      setSearchTarget(null);
    }
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
    const withCurrent =
      listed.some((item) => item.value === currentBranch) || !currentBranch
        ? listed
        : [{ value: currentBranch, label: currentBranch, hint: undefined }, ...listed];
    // A remote branch is checked out as a local one that tracks it.
    const remote = remoteBranches.map((name) => ({ value: `${REMOTE_PREFIX}${name}`, label: name, hint: "remote" as string | undefined }));
    return [...withCurrent, ...remote];
  }, [branches, remoteBranches, currentBranch]);

  async function fetchRemotes() {
    if (!worktreeId || fetching) {
      return;
    }
    setFetching(true);
    setError(null);
    try {
      const list = await workspaceFetchBranches(worktreeId);
      setBranches(list.branches);
      setRemoteBranches(list.remotes ?? []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setFetching(false);
    }
  }

  async function goToBranch(target: BranchTarget) {
    if (!worktreeId) {
      throw new Error("Open a repository first.");
    }
    // A failure goes back to the dialog, which stays open and says why.
    setWorkspace(await workspaceGoToBranch(worktreeId, target.branch, target.repository));
    void refreshBranches();
  }

  async function createBranch(name: string, base: string) {
    if (!worktreeId) {
      return;
    }
    // A failure goes back to the dialog, which stays open and says why.
    setWorkspace(await workspaceCreateBranch(worktreeId, name, base));
    void refreshBranches();
  }

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
      title: "Open folder",
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
      setError("No coding agent is available. Install Claude Code, Codex, OpenCode or Cursor first.");
      return;
    }
    setSessionsOpen(false);
    // A chat made with + that is still empty is the new chat already: it is not made twice.
    const current = selectedSession;
    if (
      current &&
      drafts.has(current.id) &&
      current.provider === provider &&
      current.worktree_id === selectedWorktree.id
    ) {
      setSpace("chat");
      return;
    }
    // Text left in an earlier + chat goes on to this one. From a + chat still on screen it is
    // taken now, before that chat is deleted for being left.
    const fromCurrent = current && drafts.has(current.id) ? loadDraft(current.id) : "";
    await runWorkspace(async () => {
      const snapshot = await workspaceCreateSession(
        selectedRepository.id,
        selectedWorktree.id,
        undefined,
        provider,
        current?.id ?? null,
      );
      // It only becomes a chat with its first message; until then the list leaves it out.
      if (snapshot.selected_session_id) {
        markDraftChat(snapshot.selected_session_id);
        setDrafts(draftChats());
        const carried = fromCurrent.trim() !== "" ? fromCurrent : takeNewChatText();
        if (carried.trim() !== "") {
          saveDraft(snapshot.selected_session_id, carried);
          if (current && fromCurrent !== "") {
            forgetDraft(current.id);
          }
        }
      }
      return snapshot;
    });
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

  // A chat the first message settled (here or in a /new) is listed from then on.
  useEffect(() => {
    const refresh = () => setDrafts(draftChats());
    window.addEventListener(DRAFT_SETTLED_EVENT, refresh);
    return () => window.removeEventListener(DRAFT_SETTLED_EVENT, refresh);
  }, []);
  // A chat made with + and left without a message is not kept: once another chat is on screen
  // (or, after a restart, any that is not on screen), it is deleted. Its text is kept for the
  // next chat made with +.
  useEffect(() => {
    if (boot.kind !== "ready") {
      return;
    }
    const known = new Set([...workspace.sessions, ...(workspace.other_sessions ?? [])].map((item) => item.id));
    const stale = [...draftChats()].filter((id) => id !== sessionId);
    if (stale.length === 0) {
      setDrafts(draftChats());
      return;
    }
    let cancelled = false;
    void (async () => {
      for (const id of stale) {
        settleDraftChat(id);
        keepNewChatText(loadDraft(id));
        forgetDraft(id);
        if (!known.has(id)) {
          continue;
        }
        try {
          const snapshot = await workspaceDeleteSession(id);
          forgetClosedSubagents(id);
          if (!cancelled) {
            setWorkspace(snapshot);
          }
        } catch {
          // It stays, as a chat with no messages; nothing is lost.
        }
      }
      if (!cancelled) {
        setDrafts(draftChats());
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs when the chat on screen changes, not on every snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, boot.kind]);

  const activity = useSessionActivity(sessionId);
  const failedArtifacts = useFailedArtifacts(sessionId);

  function watchBrowser(id: number): void {
    void browserActivate(id).then(() => setSpace("browser")).catch((err: unknown) => setError(errorMessage(err)));
  }

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
    const providerSelector = (
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
    );
    if (selectedSession) {
      return (
        <ChatPanel
          browserPreview={<BrowserPictureInPicture hidden={overlayOpen} onWatch={watchBrowser} />}
          jumpTo={searchTarget?.btwId ? undefined : conversationJump}
          key={selectedSession.id}
          contextLabel={contextLabel}
          provider={providers?.find((item) => item.kind === selectedSession.provider) ?? null}
          session={selectedSession}
          providerSelector={providerSelector}
          meterSlot={meterSlot}
          ownRoot={workspace.worktrees.find((item) => item.id === selectedSession.worktree_id)?.path ?? null}
          onNewSession={(snapshot) => {
            setDrafts(draftChats());
            setWorkspace(snapshot);
          }}
          onOpenDecisions={() => {
            setSearchTarget((target) => target?.kind === "decision_item" ? null : target);
            setDecisionsOpen(true);
          }}
          onOpenFile={openCite}
          onPreviousWorkspace={workspacePreviousWorkspace}
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
        providerSelector={providerSelector}
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
            actions={[
              { label: "New branch…", onSelect: () => setNewBranchOpen(true) },
              { label: fetching ? "Fetching…" : "Fetch from remote", onSelect: () => void fetchRemotes() },
            ]}
            options={branchOptions}
            placeholder="branch"
            searchable
            title="Branch of this worktree. Choosing another one switches to it, and says why if git refuses."
            value={currentBranch}
            onChange={(value) => {
              if (!selectedWorktree) {
                return;
              }
              if (value.startsWith(REMOTE_PREFIX)) {
                void runWorkspace(() => workspaceCheckoutRemoteBranch(selectedWorktree.id, value.slice(REMOTE_PREFIX.length)));
              } else if (value !== currentBranch) {
                void runWorkspace(() => workspaceSelectBranch(selectedWorktree.id, value));
              }
            }}
            onOpen={() => void refreshBranches()}
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

          <span ref={setMeterSlot} className="flex items-center" />

          <Tip label="MCP servers">
            <Button
              aria-label="MCP servers"
              aria-pressed={mcpOpen}
              variant="icon"
              onClick={() => setMcpOpen(true)}
            >
              <Server aria-hidden="true" size={16} />
            </Button>
          </Tip>

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
          <Tip label="Global search (Ctrl/⌘ B)">
            <Button aria-label="Global search" variant="icon" onClick={() => setSearchOpen(true)}>
              <Search aria-hidden="true" size={16} />
            </Button>
          </Tip>
          <Tip label="Chats, by workspace">
            <Button
              aria-label="Chats, by workspace"
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
          <Tip label="Tasks (Ctrl/⌘ T)">
            <Button
              aria-label="Tasks"
              aria-pressed={tasksOpen}
              variant="icon"
              onClick={() => setTasksOpen((open) => !open)}
            >
              <ListTodo aria-hidden="true" size={16} />
            </Button>
          </Tip>
          <Tip label="Memory graph (Ctrl/⌘ Shift G)">
            <Button
              aria-label="Memory graph"
              aria-pressed={memoryOpen}
              variant="icon"
              onClick={() => setMemoryOpen((open) => !open)}
            >
              <Network aria-hidden="true" size={16} />
            </Button>
          </Tip>
          <Tip label={workbenchNeeds > 0 ? `Workbench, ${workbenchNeeds} waiting for you (Ctrl/⌘ Shift E)` : "Workbench: agents side by side (Ctrl/⌘ Shift E)"}>
            <Button
              aria-label={workbenchNeeds > 0 ? `Workbench, ${workbenchNeeds} waiting for you` : "Workbench"}
              aria-pressed={space === "workbench"}
              className="relative"
              disabled={!workspace.selected_workspace_id}
              variant="icon"
              onClick={() => setSpace((current) => (current === "workbench" ? "chat" : "workbench"))}
            >
              <Users aria-hidden="true" size={16} />
              {workbenchNeeds > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full border border-cg-amber bg-cg-panel px-1 text-small leading-none font-semibold text-cg-amber-text"
                >
                  {workbenchNeeds}
                </span>
              ) : null}
            </Button>
          </Tip>
          <Tip label="Terminal (Ctrl `)">
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
                searchCheckpointId={searchTarget && searchTarget.sessionId === chatId &&
                  searchTarget.worktreeId === workspace.selected_worktree_id && isSearchReview(searchTarget) ? searchTarget.checkpointId : null}
                onCloseSearchCheckpoint={() => setSearchTarget(null)}
                openRequest={codeRequest}
                reference={reference || null}
                onReferenceChange={setReference}
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
        {visited.has("browser") ? (
          <div className={space === "browser" ? "h-full" : "hidden"}>
            <ErrorBoundary label="Browser">
              <BrowserSpace workspaceId={workspace.selected_workspace_id} overlayOpen={overlayOpen} visible={space === "browser"} onError={setError} />
            </ErrorBoundary>
          </div>
        ) : null}
        {visited.has("workbench") ? (
          <div className={space === "workbench" ? "h-full" : "hidden"}>
            <ErrorBoundary label="Workbench">
              <WorkbenchSpace
                board={board}
                chats={workbenchChats}
                visible={space === "workbench"}
                workspaceId={workspace.selected_workspace_id}
                workspaceName={inWorkspace?.workspace.name ?? ""}
                worktrees={workspace.worktrees}
                onError={setError}
                onOpenChat={openChat}
                onOpenFile={(path, line, endLine) => void openInCode(path, line, endLine)}
              />
            </ErrorBoundary>
          </div>
        ) : null}
        {visited.has("flow") ? (
          <div className={space === "flow" ? "h-full" : "hidden"}>
            <ErrorBoundary label="Flow">
              <FlowSpace
                bridge={flowBridge}
                searchTarget={searchTarget?.kind === "flow" && searchTarget.sessionId === chatId ? searchTarget : null}
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
            currentWorkspaceId={workspace.selected_workspace_id}
            otherSessions={workspace.other_sessions ?? []}
            repositoryNames={repositoryNames}
            sessions={workspace.sessions.filter((item) => !drafts.has(item.id))}
            workspaces={workspace.workspaces}
            worktrees={workspace.worktrees}
            onClose={closeSessions}
            onDelete={(id) => {
              forgetComparisons(id);
              forgetDraft(id);
              forgetClosedSubagents(id);
              settleDraftChat(id);
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

      <EdgeNav attention={{ workbench: workbenchNeeds }} space={space} onSelect={setSpace} />
      <BtwPalette
        isOpen={btwOpen}
        item={activeItem(bridges, space)}
        others={otherItems(bridges, space)}
        private={btwPrivate}
        providers={providers ?? []}
        resume={btwResume}
        jumpTo={searchTarget?.btwId === btwResume?.id ? conversationJump : undefined}
        session={selectedSession}
        space={space}
        worktreeId={selectedWorktree?.id ?? null}
        onClose={() => {
          setBtwOpen(false);
          setBtwResume(null);
          setBtwPrivate(false);
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
        onOpenDecisions={() => setDecisionsOpen(true)}
      />
      <MemoryGraph
        currentWorkspaceId={inWorkspace?.workspace.id ?? null}
        isOpen={memoryOpen}
        workspaces={memoryWorkspaces}
        onClose={() => setMemoryOpen(false)}
        onError={setError}
      />
      <TasksDrawer
        isOpen={tasksOpen}
        searchNumber={searchTarget?.kind === "task" ? Number(searchTarget.itemId) : null}
        onClose={() => {
          setTasksOpen(false);
          setSearchTarget((target) => target?.kind === "task" ? null : target);
        }}
        onError={setError}
      />
      <DecisionsReview
        isOpen={decisionsOpen}
        searchId={searchTarget?.kind === "decision_item" ? searchTarget.itemId : null}
        sessionId={selectedSession?.id ?? null}
        onClose={() => {
          setDecisionsOpen(false);
          setSearchTarget((target) => target?.kind === "decision_item" ? null : target);
        }}
        onError={setError}
        onOpenFile={(path, line) => void openInCode(path, line)}
      />
      {searchOpen ? (
        <GlobalSearch
          repositories={workspace.repositories}
          workspaces={workspace.workspaces}
          onClose={() => setSearchOpen(false)}
          onOpen={openSearchResult}
        />
      ) : null}
      <ShortcutLegend
        isOpen={legendOpen}
        onClose={() => setLegendOpen(false)}
        onTour={() => {
          setLegendOpen(false);
          setTourOpen(true);
        }}
      />
      <Onboarding isOpen={tourOpen} onClose={() => setTourOpen(false)} />
      <Companion
        chats={companionChats}
        viewing={space === "chat" ? workspace.selected_session_id : null}
        onCustomize={() => {
          setSettingsTab("pet");
          setSettingsOpen(true);
        }}
        onOpenChat={(id) => {
          void runWorkspace(async () => {
            const snapshot = await workspaceOpenSession(id);
            setSpace("chat");
            return snapshot;
          });
        }}
      />
      <SettingsDialog
        isOpen={settingsOpen}
        openTab={settingsTab}
        provider={selectedSession?.provider ?? null}
        repository={selectedRepository ? { id: selectedRepository.id, name: selectedRepository.name } : null}
        workspace={inWorkspace ? { id: inWorkspace.workspace.id, name: inWorkspace.workspace.name } : null}
        workspaces={memoryWorkspaces}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsTab(null);
        }}
        onOpenMemoryGraph={() => setMemoryOpen(true)}
      />
      <McpServersDialog
        isOpen={mcpOpen}
        onClose={() => setMcpOpen(false)}
        onOpenSession={openMcpSession}
      />
      <GoToBranchDialog
        currentBranch={currentBranch}
        isOpen={goToBranchOpen}
        onClose={() => setGoToBranchOpen(false)}
        onGo={goToBranch}
      />
      <NewBranchDialog
        currentBranch={currentBranch}
        isOpen={newBranchOpen}
        localBranches={branches.map((branch) => branch.name)}
        remoteBranches={remoteBranches}
        repositoryId={focusRepositoryId}
        sessionId={selectedSession?.id ?? null}
        onClose={() => setNewBranchOpen(false)}
        onCreate={createBranch}
      />
      <WorkspaceDialog
        isOpen={workspaceDialog !== null}
        repositories={workspace.repositories}
        workspace={workspaceDialog === "edit" ? (inWorkspace?.workspace ?? null) : null}
        onClose={() => setWorkspaceDialog(null)}
        onSaved={setWorkspace}
      />
      <UpdatePrompt />
      <Toast message={error} onDismiss={() => setError(null)} />
      <BrowserNotice inBrowser={space === "browser" || space === "chat"} onWatch={() => setSpace("browser")} />
    </div>
  );
}
