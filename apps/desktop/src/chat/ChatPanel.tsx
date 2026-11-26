import { createPortal } from "react-dom";
import { ArrowDown, ListPlus, Loader2, Mic, Paperclip, Square, Zap } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  agentCancel,
  agentCancelRateWait,
  agentConfigureSession,
  agentSetProfile,
  agentEnqueue,
  agentGetOptions,
  agentGetSnapshot,
  agentMessageSubagent,
  agentPrompt,
  agentQueueRemove,
  agentQueueSetPaused,
  agentQueueSendNow,
  agentRepositoryMcpApproval,
  agentResolvePermission,
  agentStartSession,
  agentTrustRepositoryMcp,
  chatReducer,
  initialChatState,
  listenAgentEvents,
  PROVIDER_LABELS,
  scheduleCancel,
  sessionPaths,
  waitingFor,
  withLocal,
  type ImageAttachment,
  type ProviderDescriptor,
  type QueuedLocally,
  type RepositoryMcpApproval,
  type SessionOptions,
  agentListComposerResources,
} from "../lib/agent";
import type { ChatSession, WorkspaceSnapshot } from "../lib/workspace";
import type { ConversationJump } from "../lib/search";
import { workspaceCreateSession } from "../lib/workspace";
import { play } from "../app/sound/sound";
import { toRows, withDecisionRows } from "./rows";
import { useSuggestion } from "./autocomplete";
import { AsciiMark } from "./AsciiMark";
import {
  type Attachment,
  IMAGE_ACCEPT,
  imagesFromClipboard,
  MAX_IMAGES,
  pickImages,
  toUploads,
} from "./attachments";
import { AttachmentStrip } from "./AttachmentStrip";
import { ComposerPicker } from "./ComposerPicker";
import { useBackground } from "./background";
import { Hero } from "./Hero";
import { Loader } from "./Loader";
import { seedPicture } from "./MessageImages";
import { togglePet } from "../pet/store";
import { ProfileMark } from "./ProfileMark";
import { ProfileSelect } from "./ProfileSelect";
import { QueuedMessages } from "./QueuedMessages";
import { ScheduledTasks } from "./ScheduledTasks";
import { SessionSettings } from "./SessionSettings";
import { StatusDot } from "./StatusDot";
import { UsageMeter } from "./UsageMeter";
import { ContextMeter } from "./ContextMeter";
import { SubagentBar } from "./SubagentBar";
import { DecisionsCard, useDecisions } from "../decisions/DecisionsReview";
import { loadClosedSubagents, saveClosedSubagents } from "./closedSubagents";
import { announceSettled, markDraftChat } from "./draftChats";
import { PermissionPrompt } from "./PermissionPrompt";
import { VirtualTranscript } from "./VirtualTranscript";
import { takesBack, withTakenBack } from "./takeBack";
import { isUpwardKey, stickAfterScroll } from "./stick";
import { useComposerPicker } from "./useComposerPicker";
import { useMessageQueue } from "./useMessageQueue";
import { useSchedules } from "./useSchedules";
import { loadDraft, saveDraft } from "./draftStore";
import { FileLinksContext, type FileLinks } from "./fileLinks";
import type { FileCite } from "./fileRefs";
import { useFileIndex } from "./useFileIndex";
import { useDictation } from "./useDictation";
import { RecordingBar } from "./RecordingBar";
import { SpeechModelDialog } from "./SpeechModelDialog";
import { appendDictation } from "./wav";
import { expandGlobMentions, expandSkillMention } from "./pickerChoices";
import { Dialog } from "../ui/Overlay";

const STICK_THRESHOLD_PX = 80;
const MAX_COMPOSER_PX = 160;

const TRUNK_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

/** Starting points that name the repository and branch the chat is about. */
export function suggestionsFor(contextLabel: string | null): string[] {
  const [repository, branch] = (contextLabel ?? "").split(" · ");
  const onFeature = Boolean(branch) && !TRUNK_BRANCHES.has(branch ?? "");
  return [
    onFeature ? `Explain what changed on ${branch} and why` : `Give me a tour of ${repository || "this repository"}`,
    "Find TODO and FIXME comments and group them by area",
    onFeature ? `Review ${branch} for bugs before I merge` : "Summarize the most recent commits",
  ];
}

/** What the conversation with the chat's own agent is called, next to its subagents. */
const MAIN_AGENT = "main";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ChatPanel({
  session,
  provider,
  providerSelector,
  contextLabel,
  bare = false,
  meterSlot = null,
  onSessionChange,
  onNewSession,
  onPreviousWorkspace,
  ownRoot = null,
  onOpenFile,
  onOpenDecisions,
  jumpTo,
  browserPreview,
}: {
  session: ChatSession;
  provider: ProviderDescriptor | null;
  providerSelector?: ReactNode;
  contextLabel: string | null;
  /** No agent mark or name beside the composer. */
  bare?: boolean;
  /** Where the limits and context meters are drawn (the window header); none, none shown. */
  meterSlot?: HTMLElement | null;
  onSessionChange: (session: ChatSession) => void;
  onNewSession?: (workspace: WorkspaceSnapshot) => void;
  onPreviousWorkspace?: () => Promise<WorkspaceSnapshot>;
  /** The folder of the chat's own repository: absolute paths in messages are read against it. */
  ownRoot?: string | null;
  /** Opens a file the chat named in the editor. Without it, files named in messages are plain text. */
  onOpenFile?: (cite: FileCite) => void;
  onOpenDecisions?: () => void;
  jumpTo?: ConversationJump;
  browserPreview?: ReactNode;
}) {
  const sessionId = session.id;
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  // The draft belongs to a chat and is stored as it is typed: another workspace, tab or a closed
  // app brings it back. Switching chats reads that chat's own.
  const [draftState, setDraftState] = useState(() => ({ id: sessionId, text: loadDraft(sessionId) }));
  const draft = draftState.id === sessionId ? draftState.text : loadDraft(sessionId);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const setDraft = useCallback(
    (value: string | ((current: string) => string)) => {
      const next = typeof value === "function" ? value(draftRef.current) : value;
      draftRef.current = next;
      saveDraft(sessionId, next);
      setDraftState({ id: sessionId, text: next });
    },
    [sessionId],
  );
  const [completionCaret, setCompletionCaret] = useState(0);
  const [composerFocused, setComposerFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissedCompletion, setDismissedCompletion] = useState<string | null>(null);
  const completionRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [options, setOptions] = useState<SessionOptions | null>(null);
  const [repositoryMcpApproval, setRepositoryMcpApproval] = useState<RepositoryMcpApproval | null>(null);
  const [repositoryMcpApprovalOpen, setRepositoryMcpApprovalOpen] = useState(false);
  const [trustingRepositoryMcp, setTrustingRepositoryMcp] = useState(false);
  // The subagent whose conversation is on screen; null shows the main conversation.
  const [view, setView] = useState<string | null>(null);
  // Closing a subagent hides its chip in this chat for good (it survives leaving the chat); its
  // saved conversation stays untouched.
  const [closedSubagents, setClosedSubagents] = useState<Set<string>>(() => loadClosedSubagents(session.id));
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);
  const latest = useRef(state);
  latest.current = state;
  // What was shown before the app took it in: the thumbnails to free, and the pictures' addresses.
  const pendingSends = useRef(new Map<string, { previews: string[]; urls: string[] }>());
  // The last message on its way to the agent, so the next one waits for it.
  const inFlight = useRef<Promise<unknown>>(Promise.resolve());
  const preparingSend = useRef(false);
  const [queue, setQueue] = useMessageQueue(sessionId);
  const schedules = useSchedules(sessionId);
  // What was sent to the queue and is not in the app's list yet.
  const [queuedHere, setQueuedHere] = useState<QueuedLocally[]>([]);
  const shownQueue = useMemo(() => withLocal(queue, queuedHere), [queue, queuedHere]);
  // Pictures chosen for the next message (images only for now).
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Thumbnails are object URLs: let go of them when the chat is left.
  useEffect(
    () => () => {
      attachmentsRef.current.forEach((item) => URL.revokeObjectURL(item.preview));
      pendingSends.current.forEach((mine) => mine.previews.forEach((url) => URL.revokeObjectURL(url)));
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    async function connect() {
      setRepositoryMcpApproval(null);
      setRepositoryMcpApprovalOpen(false);
      unlisten = await listenAgentEvents((event) => {
        if (event.type !== "usage" && event.sessionId === sessionId) {
          if (event.type === "delta" && event.role === "user") {
            takeIn(event.text, event.images);
          }
          dispatch({ type: "event", event });
        }
      });
      if (disposed) {
        unlisten();
        return;
      }
      try {
        const approval = await agentRepositoryMcpApproval(sessionId);
        if (approval) {
          if (!disposed) {
            setRepositoryMcpApproval(approval);
            setRepositoryMcpApprovalOpen(true);
          }
          return;
        }
        await agentStartSession(sessionId);
        const snapshot = await agentGetSnapshot(sessionId);
        if (!disposed) {
          dispatch({ type: "loaded", snapshot });
        }
      } catch (err) {
        if (!disposed) {
          const approval = await agentRepositoryMcpApproval(sessionId).catch(() => null);
          if (approval) {
            setRepositoryMcpApproval(approval);
            setRepositoryMcpApprovalOpen(true);
          } else {
            dispatch({ type: "failed", message: errorText(err) });
          }
        }
      }
    }
    void connect();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId]);

  async function trustRepositoryMcp() {
    if (!repositoryMcpApproval || trustingRepositoryMcp) {
      return;
    }
    setTrustingRepositoryMcp(true);
    try {
      await agentTrustRepositoryMcp(sessionId, repositoryMcpApproval.fingerprint);
      setRepositoryMcpApproval(null);
      setRepositoryMcpApprovalOpen(false);
      await agentStartSession(sessionId);
      dispatch({ type: "loaded", snapshot: await agentGetSnapshot(sessionId) });
    } catch (err) {
      const approval = await agentRepositoryMcpApproval(sessionId).catch(() => null);
      if (approval) {
        setRepositoryMcpApproval(approval);
        setRepositoryMcpApprovalOpen(true);
      } else {
        dispatch({ type: "failed", message: errorText(err) });
      }
    } finally {
      setTrustingRepositoryMcp(false);
    }
  }

  async function loadOptions() {
    try {
      setOptions(await agentGetOptions(sessionId));
    } catch {
      // Options are a convenience; the pickers fall back to the provider's presets.
      setOptions(null);
    }
  }

  useEffect(() => {
    if (state.loaded) {
      void loadOptions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.loaded, sessionId]);

  // Switching the harness restarts the agent underneath this chat: reload what it shows.
  const shownProvider = useRef(session.provider);
  useEffect(() => {
    if (shownProvider.current === session.provider) {
      return;
    }
    shownProvider.current = session.provider;
    setView(null);
    setOptions(null);
    void (async () => {
      try {
        dispatch({ type: "loaded", snapshot: await agentGetSnapshot(sessionId) });
        await loadOptions();
      } catch (err) {
        dispatch({ type: "failed", message: errorText(err) });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.provider]);

  // The agent asking for approval is heard as well as seen, once per request.
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    const id = state.pending?.requestId ?? null;
    if (id && askedFor.current !== id) {
      play("alert");
    }
    askedFor.current = id;
  }, [state.pending]);

  // The message field comes back when the agent's question is settled: give it the focus again.
  const hadPending = useRef(false);
  useEffect(() => {
    if (hadPending.current && !state.pending) {
      composerRef.current?.focus();
    }
    hadPending.current = state.pending !== null;
  }, [state.pending]);

  const visibleSubagents = state.subagents.filter((item) => !closedSubagents.has(item.id));
  const activeSubagent = visibleSubagents.find((item) => item.id === view) ?? null;
  const handledJump = useRef<ConversationJump | undefined>(undefined);
  const foundSubagent = state.subagents.find((item) => item.id === jumpTo?.subagentId);
  useLayoutEffect(() => {
    if (!jumpTo || handledJump.current === jumpTo || (jumpTo.subagentId && !foundSubagent)) {
      return;
    }
    handledJump.current = jumpTo;
    if (foundSubagent) {
      setClosedSubagents((current) => {
        const next = new Set(current);
        next.delete(foundSubagent.id);
        return next;
      });
    }
    setView(foundSubagent?.id ?? null);
  }, [jumpTo, foundSubagent]);
  const activeBtwSubagent = activeSubagent?.title.startsWith("BTW: ") ?? false;
  const btwSession =
    session.title.startsWith("BTW: ") && (session.kind === "btw" || session.kind === "delegate");
  const mainPermission = activeBtwSubagent ? null : state.pending;
  const canWrite =
    activeSubagent === null || activeBtwSubagent || provider?.settings.subagent_messages === true;
  // Slash actions name session resources; references point into the workspace.
  const picker = useComposerPicker({
    sessionId,
    draft,
    onDraft: setDraft,
    field: composerRef,
    commands: activeSubagent === null,
  });

  // Dictation: what is said is turned into text on this computer and lands in the field.
  const dictation = useDictation({
    onText: (text) => {
      setDraft((current) => appendDictation(current, text));
      setAttachNotice(null);
      composerRef.current?.focus();
    },
    onProblem: (message) => setAttachNotice(message),
    onNeedsModel: (megabytes) => setModelDialog({ megabytes }),
  });
  // Asked before the speech model is downloaded; once it is there, dictation starts by itself.
  const [modelDialog, setModelDialog] = useState<{ megabytes: number } | null>(null);
  const dictateRef = useRef(dictation.toggle);
  dictateRef.current = dictation.toggle;
  const cancelDictationRef = useRef(dictation.cancel);
  cancelDictationRef.current = dictation.cancel;
  useEffect(() => {
    if (bare) {
      return;
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === "KeyM" && !event.repeat) {
        event.preventDefault();
        dictateRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bare]);

  // Follow the stream while the reader is at the bottom; leave them alone once they scroll up.
  const followTranscript = useCallback(() => {
    const element = scrollRef.current;
    if (element && stickRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, []);
  useLayoutEffect(followTranscript, [followTranscript, state.items, state.status, state.pending, state.loaded, activeSubagent]);

  // Grow the composer with its content up to a cap.
  useLayoutEffect(() => {
    const element = composerRef.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, MAX_COMPOSER_PX)}px`;
    }
  }, [draft]);

  const busy = state.status === "working" || state.status === "waiting-permission";

  // The files a message names become links. They are read again when the agent stops, since that is
  // when files appear.
  const fileIndex = useFileIndex(sessionId, ownRoot, busy, Boolean(onOpenFile) && state.loaded);
  const fileLinks = useMemo<FileLinks | null>(
    () => (fileIndex && onOpenFile ? { index: fileIndex, open: onOpenFile } : null),
    [fileIndex, onOpenFile],
  );

  const lastTopRef = useRef(0);
  function onScroll() {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const stuck = stickAfterScroll(stickRef.current, element.scrollTop, lastTopRef.current, distance);
    lastTopRef.current = element.scrollTop;
    stickRef.current = stuck;
    setAtBottom(stuck || distance < STICK_THRESHOLD_PX);
  }

  // The reader's hand is heard before the scroll event arrives, and a token can pin the view to
  // the bottom in between: so what means "up" lets go of the stream right away.
  function leaveTheStream() {
    if (stickRef.current) {
      stickRef.current = false;
      setAtBottom(false);
    }
  }
  const touchY = useRef(0);

  function jumpToLatest() {
    const element = scrollRef.current;
    if (element) {
      stickRef.current = true;
      // A long way down is crossed at once: the rows in between were never measured, so a smooth
      // scroll would aim at a height that is still a guess and stop short. The bottom is pinned
      // as its rows are measured.
      const far = element.scrollHeight - element.scrollTop > element.clientHeight * 4;
      element.scrollTo({ top: element.scrollHeight, behavior: far ? "auto" : "smooth" });
    }
  }

  // While the agent works, the main conversation takes messages into a queue instead of refusing
  // them; a subagent's conversation does not queue.
  const queues = busy && activeSubagent === null && !btwSession;

  function addFiles(files: File[]) {
    const { accepted, problems } = pickImages(files, MAX_IMAGES - attachments.length);
    setAttachNotice(problems.length > 0 ? problems.join(" ") : null);
    if (accepted.length > 0) {
      setAttachments((current) => [
        ...current,
        ...accepted.map((file) => ({
          id: crypto.randomUUID(),
          file,
          preview: URL.createObjectURL(file),
        })),
      ]);
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      current.filter((item) => item.id === id).forEach((item) => URL.revokeObjectURL(item.preview));
      return current.filter((item) => item.id !== id);
    });
    setAttachNotice(null);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (activeSubagent) {
      return;
    }
    const files = imagesFromClipboard(event.clipboardData);
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
    }
  }

  /** Frees the thumbnails of a message that was shown before it was taken in. */
  function release(pendingId: string) {
    const mine = pendingSends.current.get(pendingId);
    mine?.previews.forEach((url) => URL.revokeObjectURL(url));
    pendingSends.current.delete(pendingId);
  }

  /**
   * The app has reported the user's message: if one was shown ahead of it, its pictures are now
   * known by their real ids, so they are given the pictures already in hand and do not have to
   * be fetched again, and the thumbnails made for showing it can go.
   */
  function takeIn(text: string, images?: ImageAttachment[]) {
    const waiting = waitingFor(latest.current.items, text);
    if (!waiting) {
      return;
    }
    const mine = pendingSends.current.get(waiting.id);
    images?.forEach((image, i) => {
      const url = mine?.urls[i];
      if (url) {
        seedPicture(sessionId, image.id, url);
      }
    });
    window.setTimeout(() => release(waiting.id), 1000);
  }

  /** `now` skips the line: while the agent works, the message stops it and goes next. */
  async function send(now = false) {
    if (preparingSend.current) {
      return;
    }
    const input = draftRef.current;
    let text = input.trim();
    const sending = activeSubagent ? [] : attachments;
    const commandName = /^\/([A-Za-z0-9][A-Za-z0-9_:.-]*)(?=$|\s)/.exec(text)?.[1];
    if (commandName && activeSubagent !== null) {
      setAttachNotice("Slash commands are available only in the main chat.");
      return;
    }
    if (commandName === "help" && text !== "/help") {
      setAttachNotice("Use /help without arguments.");
      return;
    }
    if (commandName === "help") {
      setDraft("");
      setAttachNotice(
        [
          "/help — list Ataraxia commands (available)",
          `/workspace — switch to the previous workspace (${onPreviousWorkspace ? "available" : "unavailable here"})`,
          `/new — create a new chat and keep this one (${onNewSession ? "available" : "unavailable here"})`,
          `/compact${provider?.capabilities.compact_instructions ? " [instructions]" : ""} — compact this conversation (${provider?.capabilities.compact ? "available" : "unavailable"})`,
          `/stop — stop the current run (${busy ? "available" : "no run active"})`,
          "/pet — show or hide the pet (available)",
        ].join("\n"),
      );
      return;
    }
    if (commandName === "pet") {
      if (text !== "/pet") {
        setAttachNotice("Use /pet without arguments.");
        return;
      }
      setDraft("");
      setAttachNotice(togglePet() === "off" ? "The pet is tucked away. Type /pet to bring it back." : "The pet is back.");
      return;
    }
    if (commandName === "workspace") {
      if (text !== "/workspace") {
        setAttachNotice("Use /workspace without arguments.");
        return;
      }
      if (!onPreviousWorkspace || !onNewSession) {
        setAttachNotice("Switching workspaces is unavailable here.");
        return;
      }
      try {
        const workspace = await onPreviousWorkspace();
        setDraft("");
        setAttachNotice(null);
        onNewSession(workspace);
      } catch (err) {
        setAttachNotice(errorText(err));
      }
      return;
    }
    if (commandName === "compact") {
      const compactCommand = /^\/compact(?:\s+([\s\S]+))?$/.exec(text);
      if (!compactCommand) {
        setAttachNotice("Use /compact with optional instructions.");
        return;
      }
      if (!provider?.capabilities.compact) {
        setAttachNotice("Compaction is unavailable for this agent.");
        return;
      }
      if (compactCommand[1]?.trim() && !provider.capabilities.compact_instructions) {
        setAttachNotice(`${provider.display_name} does not accept instructions for compaction.`);
        return;
      }
    }
    if (commandName === "stop" && text !== "/stop") {
      setAttachNotice("Use /stop without arguments.");
      return;
    }
    if (commandName === "stop") {
      setDraft("");
      setAttachNotice(null);
      if (!busy) {
        setAttachNotice("There is no run to stop.");
        return;
      }
      try {
        await agentCancel(sessionId);
      } catch (err) {
        dispatch({ type: "failed", message: errorText(err) });
      }
      return;
    }
    if (commandName === "new" && text !== "/new") {
      setAttachNotice("Use /new without arguments.");
      return;
    }
    if (commandName === "new") {
      if (!onNewSession) {
        setAttachNotice("Creating a new chat is unavailable here.");
        return;
      }
      try {
        const workspace = await workspaceCreateSession(
          session.repository_id,
          session.worktree_id,
          undefined,
          session.provider,
          session.id,
        );
        if (workspace.selected_session_id) {
          markDraftChat(workspace.selected_session_id);
        }
        onNewSession(workspace);
        setDraft("");
        setAttachNotice(null);
      } catch (err) {
        dispatch({ type: "failed", message: errorText(err) });
      }
      return;
    }
    if (
      (!text && sending.length === 0) ||
      (activeBtwSubagent && activeSubagent?.status === "running") ||
      (busy && !queues && !activeBtwSubagent)
    ) {
      return;
    }
    const resolveSkill = commandName && commandName !== "compact";
    const resolveGlobs = /@(?:"[^"]*[*?][^"]*"|[^\s]*[*?][^\s]*)/.test(text);
    if (resolveSkill || resolveGlobs) {
      preparingSend.current = true;
      try {
        if (resolveSkill) {
          const resources = await agentListComposerResources(sessionId).catch(() => []);
          text = expandSkillMention(text, resources);
        }
        if (resolveGlobs) {
          text = expandGlobMentions(text, await sessionPaths(sessionId));
        }
      } catch (err) {
        dispatch({ type: "failed", message: errorText(err) });
        return;
      } finally {
        preparingSend.current = false;
      }
      if (draftRef.current !== input || attachmentsRef.current !== attachments) {
        return;
      }
    }
    setDraft("");
    setAttachments([]);
    setAttachNotice(null);
    stickRef.current = true;
    // The first message makes a chat made with + a chat for good.
    announceSettled(sessionId);
    // A message sent straight to the agent is shown, and the agent shown as working, at once;
    // the app's own report of it replaces what is shown (see `reconcile`). What goes to the
    // queue or to a subagent is shown by its own list, when the app says so.
    const direct = !activeSubagent && !queues;
    const pendingId = direct ? `pending:${crypto.randomUUID()}` : null;
    const before = state.status;
    if (pendingId) {
      const shown = sending.map((item, i) => {
        const id = `local:${pendingId}:${i}`;
        seedPicture(sessionId, id, item.preview);
        return { id, name: item.file.name || "image", mime: item.file.type };
      });
      pendingSends.current.set(pendingId, { previews: sending.map((item) => item.preview), urls: [] });
      dispatch({ type: "optimistic", id: pendingId, text, images: shown });
    }
    // A message for the queue is listed as soon as it is sent, marked as on its way in.
    const queuedId = !direct && !activeSubagent ? `pending:${crypto.randomUUID()}` : null;
    if (queuedId) {
      setQueuedHere((all) => [
        ...all,
        {
          id: queuedId,
          text,
          images: sending.map((item) => item.file.name || "image"),
          known: new Set(queue.items.map((item) => item.id)),
        },
      ]);
    }
    const work = (async () => {
      if (activeSubagent) {
        await agentMessageSubagent(sessionId, activeSubagent.id, text);
        return;
      }
      const images = await toUploads(sending);
      if (pendingId) {
        const mine = pendingSends.current.get(pendingId);
        if (mine) {
          mine.urls = images.map((image) => `data:${image.mime};base64,${image.data}`);
        }
        await agentPrompt(sessionId, text, images);
      } else {
        // The queue takes it after what is still on its way to the agent, in order.
        await inFlight.current.catch(() => undefined);
        const known = new Set(queue.items.map((item) => item.id));
        const queued = await agentEnqueue(sessionId, text, images);
        setQueue(queued);
        if (now) {
          // Sending it now is putting it in the queue and asking for it to go first.
          const mine = queued.items.find((item) => !known.has(item.id)) ?? queued.items[queued.items.length - 1];
          if (mine) {
            setQueue(await agentQueueSendNow(sessionId, mine.id));
          }
        }
      }
    })();
    if (pendingId) {
      inFlight.current = work;
    }
    try {
      await work;
      if (!pendingId) {
        sending.forEach((item) => URL.revokeObjectURL(item.preview));
      } else {
        // The app's report of the message comes with the answer. If it somehow has not, show
        // what the app has rather than leave a message that never settles.
        window.setTimeout(() => {
          const stuck = latest.current.items.some((item) => item.kind === "message" && item.id === pendingId && item.pending);
          if (stuck) {
            void agentGetSnapshot(sessionId).then((snapshot) => dispatch({ type: "loaded", snapshot }));
          }
          release(pendingId);
        }, 3000);
      }
    } catch (err) {
      const waiting =
        pendingId !== null &&
        latest.current.items.some((item) => item.kind === "message" && item.id === pendingId && item.pending);
      if (pendingId) {
        if (waiting) {
          dispatch({ type: "rollback", id: pendingId, status: before });
        }
        release(pendingId);
      }
      // Nothing was sent: the message and its pictures are back where they were, ahead of
      // anything typed since.
      if (pendingId === null || waiting) {
        setDraft((current) => (current.trim() === "" ? input : `${input}\n${current}`));
        setAttachments(sending);
      }
      dispatch({ type: "failed", message: errorText(err) });
    } finally {
      if (queuedId) {
        setQueuedHere((all) => all.filter((message) => message.id !== queuedId));
      }
    }
  }

  function sendQueuedNow(id: string) {
    void agentQueueSendNow(sessionId, id).catch((err: unknown) =>
      dispatch({ type: "failed", message: errorText(err) }),
    );
  }

  function setQueuePaused(paused: boolean) {
    void agentQueueSetPaused(sessionId, paused).catch((err: unknown) =>
      dispatch({ type: "failed", message: errorText(err) }),
    );
  }

  function removeQueued(id: string) {
    const text = shownQueue.items.find((item) => item.id === id)?.text ?? "";
    // With nothing typed in the field, taking a message out of the queue puts it back there to be
    // edited or sent again; with something typed, that is left alone.
    const restore = takesBack(draft, text);
    agentQueueRemove(sessionId, id)
      .then(() => {
        if (restore) {
          setDraft((current) => withTakenBack(current, text));
          composerRef.current?.focus();
        }
      })
      .catch((err: unknown) => dispatch({ type: "failed", message: errorText(err) }));
  }

  async function chooseProfile(profile: string | null) {
    try {
      // The chat switches at its next message: nothing restarts until then, so nothing to reload.
      onSessionChange(await agentSetProfile(sessionId, profile));
    } catch (err) {
      dispatch({ type: "failed", message: errorText(err) });
    }
  }

  async function configure(model: string | null, effort: string | null, agent: string | null) {
    try {
      onSessionChange(await agentConfigureSession(sessionId, model, effort, agent));
      // Providers that read these at launch restart the agent; reload to show the divider.
      dispatch({ type: "loaded", snapshot: await agentGetSnapshot(sessionId) });
      await loadOptions();
    } catch (err) {
      dispatch({ type: "failed", message: errorText(err) });
    }
  }

  function cancelTurn() {
    void agentCancel(sessionId).catch((err: unknown) =>
      dispatch({ type: "failed", message: errorText(err) }),
    );
  }

  function closeSubagent(id: string) {
    setClosedSubagents((closed) => {
      const next = new Set(closed).add(id);
      saveClosedSubagents(session.id, next);
      return next;
    });
    if (view === id) {
      stickRef.current = true;
      setView(null);
    }
  }

  const suggestion = useSuggestion(
    sessionId,
    draft,
    composerFocused && !composing && !picker.open && completionCaret === draft.length && dismissedCompletion !== draft,
  );
  const completion = suggestion?.text ?? null;

  useLayoutEffect(() => {
    if (completionRef.current && composerRef.current) {
      completionRef.current.scrollTop = composerRef.current.scrollTop;
      completionRef.current.scrollLeft = composerRef.current.scrollLeft;
    }
  }, [completion, draft]);

  function acceptCompletion(text: string) {
    const next = draft + text;
    setDraft(next);
    setCompletionCaret(next.length);
    setDismissedCompletion(next);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (picker.onKeyDown(event)) {
      return;
    }
    const plain = !event.nativeEvent.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (plain && event.key === "Tab") {
      // Tab never leaves the field: it takes the whole suggestion, or does nothing.
      event.preventDefault();
      if (completion) {
        acceptCompletion(completion);
      }
      return;
    }
    if (completion && plain && event.key === "ArrowRight") {
      event.preventDefault();
      acceptCompletion(completion);
      return;
    }
    if (completion && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissedCompletion(draft);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      // While dictating, Enter ends the recording (whatever the settings say) and the words still
      // being written land in the field. It does not send: a message sent before they arrive would
      // go without them, so Enter does nothing until the writing is done.
      if (dictation.state === "recording") {
        dictation.toggle();
        return;
      }
      if (dictation.state === "transcribing") {
        return;
      }
      // Ctrl or Cmd with Enter sends at once instead of joining the queue.
      void send((event.metaKey || event.ctrlKey) && queues);
    }
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && dictation.state === "recording") {
      // Escape first throws a recording away; it never stops the agent as well.
      event.preventDefault();
      event.stopPropagation();
      dictation.cancel();
      return;
    }
    const target = event.target as HTMLElement;
    const typing = target.closest("textarea, input, select, [contenteditable='true']") !== null;
    if (!typing && isUpwardKey(event.key, event.shiftKey)) {
      leaveTheStream();
    }
    if (event.key !== "Escape") {
      return;
    }
    if (view !== null) {
      event.preventDefault();
      setView(null);
    } else if (busy) {
      event.preventDefault();
      cancelTurn();
    }
  }

  /** Whether the answer went through; the prompt lets it be given again when it did not. */
  async function resolve(allow: boolean, answers?: Record<string, string>): Promise<boolean> {
    const pending = state.pending;
    if (!pending) {
      return true;
    }
    try {
      await agentResolvePermission(sessionId, pending.requestId, allow, answers);
      dispatch({ type: "permissionResolved", requestId: pending.requestId });
      return true;
    } catch (err) {
      const message = errorText(err);
      // Already answered, which is what was wanted.
      if (message.includes("no pending permission")) {
        dispatch({ type: "permissionResolved", requestId: pending.requestId });
        return true;
      }
      dispatch({ type: "failed", message });
      return false;
    }
  }

  const providerLabel = PROVIDER_LABELS[session.provider] ?? session.provider;

  const decisionReview = useDecisions(!bare && state.loaded ? sessionId : null);
  const decisionActivity = decisionReview.generation.kind === "working" || decisionReview.state.kind === "failed";
  const rows = useMemo(
    () => withDecisionRows(
      toRows(state.items, state.restoredCount > 0 ? state.restoredCount : -1),
      decisionReview.decisions,
      decisionActivity,
    ),
    [state.items, state.restoredCount, decisionReview.decisions, decisionActivity],
  );
  const subagentRows = useMemo(
    () => (activeSubagent ? toRows(activeSubagent.items, -1) : []),
    [activeSubagent],
  );

  const background = useBackground();
  const emptyChat = state.loaded && state.items.length === 0 && !activeSubagent;

  return (
    <FileLinksContext.Provider value={fileLinks}>
    <section className="cg-chat relative flex h-full min-h-0 flex-col" onKeyDown={onPanelKeyDown}>
      {meterSlot && !bare
        ? createPortal(
            <>
              <UsageMeter label={providerLabel} profileId={session.profile} provider={session.provider} />
              <ContextMeter usage={state.contextUsage} />
            </>,
            meterSlot,
          )
        : null}
      {background.enabled ? (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <AsciiMark mark={emptyChat} />
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="relative h-full overflow-y-auto"
          onScroll={onScroll}
          onTouchMove={(event) => {
            const y = event.touches[0]?.clientY ?? touchY.current;
            if (y > touchY.current) {
              leaveTheStream();
            }
            touchY.current = y;
          }}
          onTouchStart={(event) => {
            touchY.current = event.touches[0]?.clientY ?? 0;
          }}
          onWheel={(event) => {
            if (event.deltaY < 0) {
              leaveTheStream();
            }
          }}
        >
          <div
            className={`mx-auto flex max-w-[780px] flex-col gap-9.5 px-8 ${
              emptyChat ? "min-h-full py-6" : "pt-10 pb-20"
            }`}
          >
            {activeSubagent ? (
              <>
                <div className="flex items-center gap-2 text-small text-cg-muted">
                  <span className="text-small font-semibold">
                    Subagent
                  </span>
                  <span aria-hidden="true">·</span>
                  <strong className="truncate font-semibold text-cg-ink">
                    {activeSubagent.title}
                  </strong>
                  <span aria-hidden="true">·</span>
                  <span>{activeSubagent.status === "running" ? "working" : activeSubagent.status}</span>
                </div>
                {subagentRows.length === 0 ? (
                  <p className="text-small text-cg-muted">
                    {activeSubagent.status === "running"
                      ? "Waiting for this subagent to report…"
                      : "Nothing reported by this subagent."}
                  </p>
                ) : null}
                {subagentRows.length > 0 ? (
                  <VirtualTranscript
                    key={activeSubagent.id}
                    rows={subagentRows}
                    scrollRef={scrollRef}
                    sessionId={sessionId}
                    stick={stickRef}
                  />
                ) : null}
                {activeSubagent.status === "running" ? (
                  <Loader label="Subagent working" />
                ) : null}
              </>
            ) : (
              <>
            {state.loaded && state.items.length > 0 ? (
              <div className="flex items-center gap-2 text-small text-cg-muted">
                <span className="text-small font-semibold">
                  Coding session
                </span>
                <span aria-hidden="true">·</span>
                <strong className="truncate font-semibold text-cg-ink">{session.title}</strong>
              </div>
            ) : null}

            {!state.loaded && repositoryMcpApproval && !repositoryMcpApprovalOpen ? (
              <div className="mx-auto flex max-w-lg flex-col items-center gap-3 py-16 text-center" role="status">
                <p className="text-small text-cg-muted-strong">
                  This chat has not started because its repository MCP servers need approval.
                </p>
                <button
                  className="rounded-cg-md border border-cg-line px-3 py-2 text-small text-cg-muted-strong hover:text-cg-ink"
                  type="button"
                  onClick={() => setRepositoryMcpApprovalOpen(true)}
                >
                  Review servers
                </button>
              </div>
            ) : !state.loaded ? (
              <p className="py-16 text-center text-small text-cg-muted">
                Starting {providerLabel}…
              </p>
            ) : null}

            {emptyChat ? (
              <Hero contextLabel={contextLabel}>
                <div className="mt-8 flex flex-wrap justify-center gap-2">
                  {suggestionsFor(contextLabel).map((suggestion) => (
                    <button
                      key={suggestion}
                      className="rounded-cg-md border border-cg-line px-3 py-2 text-small text-cg-muted-strong hover:border-cg-line-strong hover:text-cg-ink"
                      type="button"
                      onClick={() => {
                        setDraft(suggestion);
                        composerRef.current?.focus();
                      }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </Hero>
            ) : null}

            {rows.length > 0 ? (
              <VirtualTranscript
                key="main"
                jumpTo={jumpTo}
                rows={rows}
                renderDecisions={(row) => (
                  <DecisionsCard
                    review={decisionReview}
                    decisions={row.decisions}
                    onOpenFullscreen={onOpenDecisions}
                    onOpenFile={onOpenFile ? (path, line) => onOpenFile({ path, line, endLine: null }) : undefined}
                  />
                )}
                scrollRef={scrollRef}
                sessionId={sessionId}
                stick={stickRef}
              />
            ) : null}

            {busy ? (
              <Loader label={state.status === "waiting-permission" ? "Waiting for approval" : "Working"} />
            ) : null}
              </>
            )}
          </div>
        </div>

        {!atBottom ? (
          <button
            aria-label="Jump to latest"
            className="absolute right-6 bottom-3 flex items-center gap-1 rounded-cg-md border border-cg-line-strong bg-cg-panel px-3 py-1.5 text-small text-cg-muted-strong shadow-cg-lift hover:text-cg-ink"
            type="button"
            onClick={jumpToLatest}
          >
            <ArrowDown size={12} />
            Latest
          </button>
        ) : null}
        {browserPreview}
      </div>

      {state.rateLimitAt ? (
        <div role="status" className="mx-auto mb-2 flex w-full max-w-[780px] items-center justify-between gap-3 rounded-cg-md border border-cg-line bg-cg-panel px-3.5 py-2.5 text-small text-cg-ink">
          <span>Usage limit reached. The task will resume after {new Date(state.rateLimitAt * 1000).toLocaleString()} while Ataraxia is open.</span>
          <button type="button" className="shrink-0 underline" onClick={() => void agentCancelRateWait(sessionId).then(() => dispatch({ type: "cancelRateWait" })).catch((err: unknown) => dispatch({ type: "failed", message: errorText(err) }))}>Cancel automatic resume</button>
        </div>
      ) : null}
      {state.error ? (
        <div
          role="alert"
          className="mx-auto mb-2 flex w-full max-w-[780px] items-center justify-between rounded-cg-md bg-cg-del-bg px-3.5 py-2.5 text-small text-cg-del-fg"
        >
          <span className="min-w-0 break-words">{state.error}</span>
          <button
            className="ml-3 shrink-0 text-small underline"
            type="button"
            onClick={() => dispatch({ type: "dismissError" })}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <Dialog
        isOpen={repositoryMcpApprovalOpen}
        label="Trust repository MCP servers"
        onClose={() => {
          if (!trustingRepositoryMcp) {
            setRepositoryMcpApprovalOpen(false);
          }
        }}
      >
        {repositoryMcpApproval ? (
          <div className="flex flex-col gap-4 p-5">
            <div>
              <h2 className="text-heading font-semibold">Trust repository MCP servers?</h2>
              <p className="mt-2 break-all text-small text-cg-muted">{repositoryMcpApproval.repository}</p>
              <p className="mt-3 text-small text-cg-muted-strong">
                These servers come from the repository and will start with the harness. Review each
                command, URL, and working directory before trusting this configuration.
              </p>
            </div>
            <ul className="flex max-h-64 flex-col gap-3 overflow-y-auto rounded-cg-md border border-cg-line p-3">
              {repositoryMcpApproval.servers.map((server) => (
                <li key={server.name} className="min-w-0 text-small">
                  <strong className="text-cg-ink">{server.name}</strong>
                  <code className="mt-1 block break-all text-cg-muted-strong">
                    {server.command
                      ? [server.command, ...server.args].join(" ")
                      : server.url}
                  </code>
                  {server.cwd ? (
                    <span className="mt-1 block break-all text-cg-muted">
                      Working directory: {server.cwd}
                    </span>
                  ) : null}
                  {server.environment.length > 0 ? (
                    <span className="mt-1 block text-cg-muted">
                      Environment variables: {server.environment.join(", ")}
                    </span>
                  ) : null}
                  {server.headers.length > 0 ? (
                    <span className="mt-1 block text-cg-muted">
                      Headers: {server.headers.join(", ")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button
                className="rounded-cg-md border border-cg-line px-3 py-2 text-small text-cg-muted-strong hover:text-cg-ink"
                disabled={trustingRepositoryMcp}
                type="button"
                onClick={() => setRepositoryMcpApprovalOpen(false)}
              >
                Cancel
              </button>
              <button
                className="rounded-cg-md bg-cg-accent px-3 py-2 text-small font-semibold text-white disabled:opacity-60"
                disabled={trustingRepositoryMcp}
                type="button"
                onClick={() => void trustRepositoryMcp()}
              >
                {trustingRepositoryMcp ? "Starting…" : "Trust repository and start"}
              </button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <SpeechModelDialog
        isOpen={modelDialog !== null}
        megabytes={modelDialog?.megabytes ?? 0}
        onClose={() => setModelDialog(null)}
        onReady={() => {
          setModelDialog(null);
          dictation.toggle();
        }}
      />

      <SubagentBar
        busy={busy && view !== null && !activeBtwSubagent}
        mainLabel={MAIN_AGENT}
        provider={session.provider}
        selected={activeSubagent ? activeSubagent.id : null}
        subagents={visibleSubagents}
        onSelect={(id) => {
          stickRef.current = true;
          setView(id);
        }}
        onClose={closeSubagent}
        onStop={cancelTurn}
      />

      {mainPermission ? (
        // What the agent is waiting for takes the place of the message field until it is settled.
        // The field stays in the page, hidden, so what was typed in it is still there after.
        <div className="relative mx-auto w-full max-w-[840px] flex-none px-8.5 pt-2.5 pb-6.5">
          <PermissionPrompt
            pending={mainPermission}
            onResolve={resolve}
          />
        </div>
      ) : null}

      <form
        className={`relative mx-auto w-full max-w-[840px] flex-none px-8.5 pt-2.5 pb-6.5 ${mainPermission ? "hidden" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {activeSubagent ? null : (
          <>
            <ScheduledTasks
              schedules={schedules}
              onCancel={(id) => {
                void scheduleCancel(sessionId, id).catch(() => {});
              }}
            />
            <QueuedMessages queue={shownQueue} onRemove={removeQueued} onSendNow={sendQueuedNow} onSetPaused={setQueuePaused} />
          </>
        )}
        <div className="cg-field relative rounded-cg-lg bg-cg-tint px-4 py-3.5">
          <ComposerPicker
            active={picker.active}
            id={picker.listId}
            items={picker.open ? picker.items : []}
            label={picker.label}
            onHover={picker.hover}
            onPick={picker.pick}
          />
          {attachNotice ? (
            <p className="mb-2 whitespace-pre-line text-small text-cg-del-fg" role="status">
              {attachNotice}
            </p>
          ) : null}
          <RecordingBar
            autoStop={dictation.autoStop}
            listening={dictation.listening}
            loudness={dictation.loudness}
            partial={dictation.partial}
            silence={dictation.silence}
            state={dictation.state}
          />
          <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
          <div className="relative">
          {completion ? <div ref={completionRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-body [overflow-wrap:anywhere]"><span className="invisible">{draft}</span><span className="text-cg-muted">{completion}</span></div> : null}
          <textarea
            ref={composerRef}
            aria-activedescendant={picker.activeId}
            aria-controls={picker.open ? picker.listId : undefined}
            aria-expanded={picker.open}
            aria-haspopup="listbox"
            aria-label="Message"
            aria-description={completion ? `Suggestion: ${completion}. Press Tab or Right Arrow to accept all of it.` : undefined}
            className="relative block max-h-40 min-h-[47px] w-full resize-none border-0 bg-transparent text-body text-cg-ink outline-none placeholder:text-cg-muted"
            disabled={!state.loaded || !canWrite}
            placeholder={
              activeSubagent
                ? canWrite
                  ? `Message ${activeSubagent.title}…`
                  : "This provider cannot message a subagent"
                : queues
                  ? "Queue a message for when the agent finishes…"
                  : `Ask ${MAIN_AGENT} to change something…`
            }
            rows={2}
            value={draft}
            onChange={(event) => {
              const element = event.currentTarget;
              picker.onChange(element);
              setCompletionCaret(element.selectionStart);
              setDismissedCompletion(null);
            }}
            onFocus={(event) => { setComposerFocused(true); setCompletionCaret(event.currentTarget.selectionStart); }}
            onBlur={() => setComposerFocused(false)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onScroll={(event) => { if (completionRef.current) completionRef.current.scrollTop = event.currentTarget.scrollTop; }}
            onClick={(event) => { picker.onSelect(event.currentTarget); setCompletionCaret(event.currentTarget.selectionStart); }}
            onKeyDown={onComposerKeyDown}
            onKeyUp={(event) => { picker.onSelect(event.currentTarget); setCompletionCaret(event.currentTarget.selectionStart); }}
            onPaste={onPaste}
          />
          </div>
          <div className="mt-1 flex min-h-[29px] items-center justify-between text-small text-cg-muted">
            <div className="flex min-w-0 items-center gap-4">
              {bare ? null : (
                <div className="flex min-w-0 items-center gap-2.5">
                  <ProfileMark profileId={session.profile} provider={session.provider} size={24} />
                  {providerSelector ?? <span className="truncate text-ui font-semibold text-cg-ink">{MAIN_AGENT}</span>}
                </div>
              )}
              {bare || activeSubagent ? null : (
                <ProfileSelect
                  disabled={busy || !state.loaded}
                  disabledReason="Wait for the current turn to finish"
                  provider={session.provider}
                  value={session.profile}
                  onChange={(profile) => {
                    void chooseProfile(profile);
                  }}
                />
              )}
              <StatusDot status={state.status} />
              {activeSubagent ? null : (
              <SessionSettings
                disabled={busy || !state.loaded}
                disabledReason="Wait for the current turn to finish"
                agent={session.agent}
                effort={session.effort}
                model={session.model}
                options={options}
                provider={provider}
                onChange={(model, effort, agent) => {
                  void configure(model, effort, agent);
                }}
              />
              )}
            </div>
            {activeSubagent ? (
              <button
                className="rounded-cg-sm px-2 py-1 text-small text-cg-muted-strong hover:bg-cg-line hover:text-cg-ink"
                type="button"
                onClick={() => setView(null)}
              >
                ← Back to {MAIN_AGENT} (Esc)
              </button>
            ) : (
            <div className="flex flex-none items-center gap-3">
              {queues ? (
                <>
                  <button
                    className="flex h-[29px] items-center gap-1.5 rounded-cg-md border border-cg-line-strong px-2.5 text-small text-cg-muted-strong hover:bg-cg-line hover:text-cg-ink disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={draft.trim() === "" && attachments.length === 0}
                    title="Stop the agent and send this message next (Ctrl/⌘ Enter)"
                    type="button"
                    onClick={() => void send(true)}
                  >
                    <Zap aria-hidden="true" size={13} />
                    Send now
                  </button>
                  <button
                    className="flex h-[29px] items-center gap-1.5 rounded-cg-md border border-cg-line-strong px-2.5 text-small text-cg-muted-strong hover:bg-cg-line hover:text-cg-ink disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={draft.trim() === "" && attachments.length === 0}
                    title="Add to the queue (Enter)"
                    type="submit"
                  >
                    <ListPlus aria-hidden="true" size={13} />
                    Queue
                  </button>
                </>
              ) : null}
              {busy ? (
                <button
                  aria-label="Stop"
                  className="grid h-[29px] w-[29px] place-items-center rounded-cg-md bg-cg-primary text-cg-on-primary hover:bg-cg-primary-hover"
                  type="button"
                  onClick={cancelTurn}
                >
                  <Square fill="currentColor" size={11} />
                </button>
              ) : null}
              {activeSubagent ? null : (
                <>
                  {dictation.supported ? (
                    <button
                      aria-label={
                        dictation.state === "recording"
                          ? "Stop recording"
                          : dictation.state === "transcribing"
                            ? "Writing what you said"
                            : "Dictate"
                      }
                      aria-pressed={dictation.state === "recording"}
                      className={`relative grid h-[29px] w-[29px] flex-none place-items-center rounded-cg-md hover:bg-cg-line hover:text-cg-ink disabled:cursor-not-allowed disabled:opacity-50 ${
                        dictation.state === "recording" ? "bg-cg-del-bg text-cg-del-fg" : "text-cg-muted-strong"
                      }`}
                      disabled={!state.loaded || dictation.state === "starting" || dictation.state === "transcribing"}
                      title={
                        dictation.state === "recording"
                          ? "Stop now (Ctrl/⌘ Shift M). It also stops by itself after a pause. Esc drops what is not written yet"
                          : "Dictate: speak, and it is written here as you go, on this computer (Ctrl/⌘ Shift M)"
                      }
                      type="button"
                      onClick={dictation.toggle}
                    >
                      {dictation.state === "transcribing" || dictation.state === "starting" ? (
                        <Loader2 aria-hidden="true" className="animate-spin" size={15} />
                      ) : dictation.state === "recording" ? (
                        <Square aria-hidden="true" fill="currentColor" size={11} />
                      ) : (
                        <Mic aria-hidden="true" size={15} />
                      )}
                      {dictation.state === "recording" ? (
                        <span
                          aria-hidden="true"
                          className="absolute inset-0 rounded-cg-md border border-cg-del-fg"
                          style={{ opacity: 0.25 + dictation.loudness * 4, transform: `scale(${1 + Math.min(0.35, dictation.loudness * 3)})` }}
                        />
                      ) : null}
                    </button>
                  ) : null}
                  <input
                    ref={fileInputRef}
                    accept={IMAGE_ACCEPT}
                    aria-hidden="true"
                    className="hidden"
                    multiple
                    tabIndex={-1}
                    type="file"
                    onChange={(event) => {
                      addFiles(Array.from(event.target.files ?? []));
                      event.target.value = "";
                    }}
                  />
                  <button
                    aria-label="Attach images"
                    className="grid h-[29px] w-[29px] flex-none place-items-center rounded-cg-md text-cg-muted-strong hover:bg-cg-line hover:text-cg-ink disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!state.loaded || attachments.length >= MAX_IMAGES}
                    title="Attach images (PNG, JPEG, GIF or WebP), or paste them"
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip aria-hidden="true" size={15} />
                  </button>
                </>
              )}
            </div>
            )}
          </div>
        </div>
      </form>
    </section>
    </FileLinksContext.Provider>
  );
}
