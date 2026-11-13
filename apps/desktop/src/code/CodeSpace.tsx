import { Check, CircleAlert, GitCompareArrows, Lock, WrapText } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { RepositorySelect } from "../app/RepositorySelect";
import type { SpaceBridge } from "../app/spaceCommands";
import {
  codeAddComment,
  codeFileAt,
  codeRead,
  codeCompare,
  codeRefreshCheckpoint,
  codeReview,
  reviewResetPriority,
  codeSetReviewMark,
  codeTree,
  codeWrite,
  type FileContent,
  type RepoChanges,
  type ReviewState,
  type ReviewView,
  type Unit,
} from "../lib/insights";
import { errorCode, errorText, useInsightEvents } from "../lib/useInsightEvents";
import { listenFilesChanged, type ChatSession, type Repository, type RepositoryId, type Worktree } from "../lib/workspace";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Segmented, Tip } from "../ui/Overlay";
import { Loading, LOADING, READY, type LoadState } from "../ui/State";
import { CommentComposer } from "./CommentComposer";
import { ChangedList, ComponentQueue, ProjectTree } from "./FileLists";
import type { EditorHandle, EditorSelection, LineMarks } from "./MonacoEditor";
import {
  ancestors,
  shownLabel,
  fileScore,
  languageFor,
  latestOfTurns,
  lineChanges,
  mapLine,
  noDiffMessage,
  stepIn,
  unchanged,
  unitLine,
  unitQueue,
} from "./model";
import { ShownRow } from "./ShownRow";
import { createSyncScheduler } from "./sync";

// Monaco is large and Code may never be opened: load it with the space, not with the app.
const MonacoEditor = lazy(() => import("./MonacoEditor").then((module) => ({ default: module.MonacoEditor })));

type Mode = "components" | "changed" | "tree";
type Version = "current" | "previous";

const MODES = [
  { id: "components", label: "Components" },
  { id: "changed", label: "Changed" },
  { id: "tree", label: "Files" },
] as const;

const MODE_KEY = "ataraxia.codeMode";

function readMode(): Mode {
  try {
    const stored = window.localStorage.getItem(MODE_KEY);
    if (stored === "components" || stored === "changed" || stored === "tree") {
      return stored;
    }
  } catch {
    // Storage may be unavailable; the default is fine.
  }
  return "components";
}

const WRAP_KEY = "ataraxia.codeWrap";

function readWrap(): boolean {
  try {
    return window.localStorage.getItem(WRAP_KEY) === "on";
  } catch {
    return false;
  }
}

type Doc = {
  path: string;
  /** What is on disk now; `null` when the file does not exist (deleted). */
  disk: FileContent | null;
  /** The file at the start of the checkpoint; `null` when it did not exist then. */
  base: string | null;
  /** What the editor holds. Differs from disk while there are unsaved edits. */
  buffer: string;
  /** The file as the checkpoint ended; compared with disk to notice later edits. */
  head: string | null;
  /** The head is a fixed revision: `disk` holds that revision's text and nothing can be saved. */
  fixed: boolean;
  /** The file was removed from disk while it was open; the buffer still holds its text. */
  gone?: boolean;
};

export function CodeSpace({
  session,
  worktree,
  bridge,
  openRequest,
  reference,
  repositories = [],
  changes = [],
  onSelectRepository,
  onReviewChanged,
  onBtw,
  onError,
}: {
  session: ChatSession | null;
  worktree: Worktree | null;
  /** The repositories of the workspace; a selector for the one shown appears when there are two or more. */
  repositories?: readonly Repository[];
  /** What the agent changed in each of them, for the selector. */
  changes?: readonly RepoChanges[];
  onSelectRepository?: (id: RepositoryId) => void;
  /** A file was marked, so the counts in the repository selector are out of date. */
  onReviewChanged?: () => void;
  bridge: MutableRefObject<SpaceBridge>;
  /** Another space asked to show a file here (a decision's code, a diagram node). */
  openRequest?: { path: string; line: number | null; n: number } | null;
  /** The branch or commit the header picked: when set, the current branch is shown against it. */
  reference: string | null;
  onBtw: () => void;
  onError: (message: string) => void;
}) {
  const [mode, setModeState] = useState<Mode>(readMode);
  // Long lines run on by default, as in a diff; one shortcut (Alt+Z) wraps them, and it is remembered.
  const [wrap, setWrap] = useState(readWrap);
  const toggleWrap = useCallback(() => {
    setWrap((now) => {
      try {
        window.localStorage.setItem(WRAP_KEY, now ? "off" : "on");
      } catch {
        // Not remembering the choice is harmless.
      }
      return !now;
    });
  }, []);
  const [review, setReview] = useState<ReviewView | null>(null);
  const [tree, setTree] = useState<string[]>([]);
  const [reviewState, setReviewState] = useState<LoadState>(LOADING);
  const [treeState, setTreeState] = useState<LoadState>(LOADING);
  const reviewShown = useRef(false);
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(new Set());
  const [doc, setDoc] = useState<Doc | null>(null);
  const [version, setVersion] = useState<Version>("current");
  const [conflict, setConflict] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [compareProblem, setCompareProblem] = useState<string | null>(null);
  const [activeUnit, setActiveUnit] = useState<string | null>(null);
  const editor = useRef<EditorHandle>(null);
  const fileSection = useRef<HTMLElement>(null);
  const selection = useRef<EditorSelection | null>(null);
  const docRef = useRef<Doc | null>(null);
  docRef.current = doc;

  const sessionId = session?.id ?? null;
  const worktreeId = worktree?.id ?? null;
  // The repository shown: the review, the comparison and the checkpoints are all of this one.
  const repositoryId = worktree?.repository_id ?? null;
  const checkpoint = review?.checkpoint ?? null;

  function setMode(next: Mode) {
    setModeState(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // Not remembering the mode is harmless.
    }
  }

  // `quiet` is a reload nobody asked for (the files changed under the app): it never shows a
  // notice for a hiccup and leaves the screen alone when it found nothing new.
  const loadReview = useCallback(
    async (checkpointId: string | null, quiet = false) => {
      if (!sessionId) {
        setReview(null);
        setReviewState(READY);
        return;
      }
      try {
        const next = await codeReview(sessionId, checkpointId, repositoryId);
        setReview((current) => (unchanged(current, next) ? current : next));
        reviewShown.current = true;
        setReviewState(READY);
      } catch (err) {
        if (quiet) {
          return;
        }
        // Once a review is on screen a failed refresh is a notice; before that it is the screen.
        if (reviewShown.current) {
          onError(errorText(err));
        } else {
          setReviewState({ kind: "failed", message: errorText(err) });
        }
      }
    },
    [sessionId, repositoryId, onError],
  );

  /**
   * What the review shows: the current branch against the reference the header picked, or, with
   * no reference, only what the agent changed in its last turn (nothing is compared by default).
   * Comparing records the working tree as it is now, so asking again after an edit shows the edit.
   */
  const openTarget = useCallback(
    async (quiet = false) => {
      if (reference && sessionId) {
        try {
          const compared = await codeCompare(sessionId, reference, null, true, repositoryId);
          setCompareProblem(null);
          await loadReview(compared.id, quiet);
          return;
        } catch (err) {
          // A hiccup while the files are changing (git busy) is not an answer: keep what is shown.
          if (quiet && errorCode(err) !== "invalid" && errorCode(err) !== "not-found") {
            return;
          }
          setReview(null);
          reviewShown.current = true;
          setReviewState(READY);
          setCompareProblem(errorText(err));
          return;
        }
      }
      setCompareProblem(null);
      await loadReview(null, quiet);
    },
    [reference, sessionId, repositoryId, loadReview],
  );

  useEffect(() => {
    setDoc(null);
    setActiveUnit(null);
    setReview(null);
    reviewShown.current = false;
    setReviewState(LOADING);
    void openTarget();
  }, [openTarget]);

  // `quiet`: the files changed under the app, so the list is read again without a spinner and the
  // screen is left alone when it came back the same.
  const loadTree = useCallback(
    (quiet = false) => {
      if (!worktreeId) {
        setTree([]);
        setTreeState(READY);
        return;
      }
      if (!quiet) {
        setTreeState(LOADING);
      }
      codeTree(worktreeId)
        .then((paths) => {
          setTree((current) => (unchanged(current, paths) ? current : paths));
          setTreeState(READY);
        })
        .catch((err: unknown) => {
          if (!quiet) {
            setTreeState({ kind: "failed", message: errorText(err) });
          }
        });
    },
    [worktreeId],
  );

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  // A checkout (here or in a terminal) changes the files and what the branch differs by: start over.
  const branch = worktree?.branch ?? null;
  const shownBranch = useRef(branch);
  useEffect(() => {
    if (shownBranch.current === branch) {
      return;
    }
    shownBranch.current = branch;
    setDoc(null);
    setActiveUnit(null);
    loadTree();
    void openTarget();
  }, [branch, loadTree, openTarget]);

  useInsightEvents((event) => {
    if (event.type === "cleared" && event.sessionId === sessionId) {
      setDoc(null);
      setActiveUnit(null);
      void openTarget();
      return;
    }
    if (event.type === "checkpoint" && event.sessionId === sessionId) {
      if (reference) {
        void openTarget(true);
        return;
      }
      // The view follows the agent's latest turn; a comparison made earlier does not count.
      const latest = latestOfTurns(review?.checkpoints ?? []);
      void loadReview(checkpoint && latest?.id !== checkpoint.id ? checkpoint.id : null);
    }
  });

  const files = checkpoint?.files ?? [];
  const priority = review?.priority ?? null;
  const marks = useMemo(
    () => new Map((review?.marks ?? []).map((mark) => [mark.path, mark.state])),
    [review?.marks],
  );
  const changeByPath = useMemo(() => new Map(files.map((file) => [file.path, file.change])), [files]);
  const queue = useMemo(() => {
    if (mode === "tree") {
      return tree;
    }
    return [...files.map((file) => file.path)].sort();
  }, [mode, tree, files]);
  const units = useMemo(() => unitQueue(priority), [priority]);
  const headLive = checkpoint?.head_live !== false;

  const openFile = useCallback(
    async (path: string) => {
      if (!worktreeId) {
        return;
      }
      if (docRef.current?.path === path) {
        return;
      }
      try {
        const inCheckpoint = checkpoint?.files.some((file) => file.path === path) ?? false;
        // A branch or commit as the head is a fixed revision: read it from git, not from disk.
        const fixed = Boolean(checkpoint && inCheckpoint && !headLive);
        let disk: FileContent | null = null;
        let head: string | null = null;
        if (fixed && checkpoint) {
          head = await codeFileAt(checkpoint.id, path, "head");
          disk = head === null ? null : { path, text: head, binary: false, tooLarge: false, size: head.length, mtimeMs: 0 };
        } else {
          try {
            disk = await codeRead(worktreeId, path);
          } catch (err) {
            if (errorCode(err) !== "not-found") {
              throw err;
            }
          }
          head = checkpoint && inCheckpoint ? await codeFileAt(checkpoint.id, path, "head") : null;
        }
        const base = checkpoint && inCheckpoint ? await codeFileAt(checkpoint.id, path, "base") : null;
        setDoc({ path, disk, base, buffer: disk?.text ?? "", head, fixed });
        setConflict(false);
        setVersion(disk ? "current" : "previous");
        setOpenFolders((current) => new Set([...current, ...ancestors(path)]));
        // Opening a file counts as seeing it, but never downgrades a judgment already made.
        if (mode !== "tree" && inCheckpoint && checkpoint && !marks.has(path)) {
          void codeSetReviewMark(checkpoint.id, path, "viewed").then((saved) =>
            setReview((view) =>
              view ? { ...view, marks: [...view.marks.filter((item) => item.path !== path), saved] } : view,
            ),
          );
        }
      } catch (err) {
        onError(errorText(err));
      }
    },
    [worktreeId, checkpoint, headLive, mode, marks, onError],
  );

  const openUnit = useCallback(
    async (unit: Unit) => {
      setActiveUnit(unit.id);
      await openFile(unit.path);
    },
    [openFile],
  );

  // Landing on a unit shows the side it lives on and scrolls to it.
  useEffect(() => {
    const unit = units.find((item) => item.id === activeUnit);
    if (!unit || !doc || doc.path !== unit.path) {
      return;
    }
    if (unit.side === "base" && doc.base !== null) {
      setVersion("previous");
    } else if (doc.disk) {
      setVersion("current");
    }
    const timer = setTimeout(() => editor.current?.reveal(Math.max(1, unitLine(unit) - 2)), 140);
    return () => clearTimeout(timer);
    // The unit and the file it opened decide this; later edits must not scroll the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUnit, doc?.path]);

  // The current version is the working tree, so it can be edited. The previous version is the past,
  // and so is a branch or commit taken as the head: neither can be.
  const dirty = doc?.disk && !doc.fixed ? doc.buffer !== doc.disk.text : false;
  // A file removed from disk is read-only unless it holds edits that were not saved: those stay
  // editable so they can still be written back.
  const readOnly = version === "previous" || !doc?.disk || Boolean(doc?.fixed) || Boolean(doc?.gone && !dirty);
  // The file changed after the checkpoint was taken: "current" is no longer what it recorded.
  const editedSince = Boolean(doc && !doc.fixed && doc.head !== null && doc.disk && doc.disk.text !== doc.head);
  const hasPrevious = Boolean(doc && (doc.base !== null || !doc.disk));
  const inCheckpoint = Boolean(doc && changeByPath.has(doc.path));

  const toggleVersion = useCallback(() => {
    const current = docRef.current;
    if (!current || !inCheckpoint) {
      return;
    }
    const top = editor.current?.topLine() ?? 1;
    const older = current.base ?? "";
    const newer = current.buffer;
    const next: Version = version === "current" ? "previous" : "current";
    if (next === "previous" && current.base === null && current.disk) {
      // The file is new in this checkpoint: there is no earlier version to show.
      return;
    }
    if (next === "current" && !current.disk) {
      return;
    }
    setVersion(next);
    const target = mapLine(older, newer, top, next === "previous" ? "newer" : "older");
    requestAnimationFrame(() => requestAnimationFrame(() => editor.current?.reveal(target)));
  }, [inCheckpoint, version]);

  const save = useCallback(
    async (overwrite = false) => {
      const current = docRef.current;
      if (!current?.disk || current.fixed || !worktreeId || saving) {
        return;
      }
      const text = editor.current?.value() ?? current.buffer;
      // A file removed from disk is written again as it is (nothing there to conflict with).
      if (text === current.disk.text && !overwrite && !current.gone) {
        return;
      }
      setSaving(true);
      try {
        const mtimeMs = await codeWrite(worktreeId, current.path, text, overwrite || current.gone ? null : current.disk.mtimeMs);
        setDoc((state) =>
          state && state.path === current.path
            ? { ...state, gone: false, buffer: text, disk: state.disk ? { ...state.disk, text, mtimeMs } : state.disk }
            : state,
        );
        setConflict(false);
      } catch (err) {
        if (errorCode(err) === "conflict") {
          setConflict(true);
        } else {
          onError(errorText(err));
        }
      } finally {
        setSaving(false);
      }
    },
    [worktreeId, saving, onError],
  );

  // Ctrl or Cmd S saves the open file from anywhere in the Code space (the editor already does when
  // it has the focus, and then this never sees the key).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
        return;
      }
      // The Code space stays mounted, hidden, while another space is on screen: not then.
      const visible = fileSection.current?.offsetParent !== null && fileSection.current !== null;
      if (!visible || !docRef.current?.disk || docRef.current.fixed) {
        return;
      }
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const reloadFromDisk = useCallback(async () => {
    const current = docRef.current;
    if (!current || !worktreeId) {
      return;
    }
    try {
      const disk = await codeRead(worktreeId, current.path);
      setDoc((state) => (state && state.path === current.path ? { ...state, disk, buffer: disk.text } : state));
      setConflict(false);
    } catch (err) {
      onError(errorText(err));
    }
  }, [worktreeId, onError]);

  // Reads the open file again: another program, or a git command in a terminal, may have changed
  // or removed it. A clean buffer follows the disk; one with unsaved edits is never replaced (a
  // change is a conflict, a removal keeps the text on screen and says so).
  const syncOpenDoc = useCallback(async () => {
    const current = docRef.current;
    if (!current || current.fixed || !worktreeId) {
      return;
    }
    let disk: FileContent;
    try {
      disk = await codeRead(worktreeId, current.path);
    } catch (err) {
      if (errorCode(err) === "not-found" && current.disk) {
        setDoc((state) => (state && state.path === current.path && !state.gone ? { ...state, gone: true } : state));
      }
      return;
    }
    const latest = docRef.current;
    if (!latest || latest.path !== current.path || latest.fixed) {
      return;
    }
    if (!latest.disk) {
      // It was missing when opened and is back.
      setDoc((state) => (state && state.path === latest.path ? { ...state, disk, buffer: disk.text, gone: false } : state));
      setVersion("current");
      return;
    }
    if (disk.mtimeMs === latest.disk.mtimeMs && !latest.gone) {
      return;
    }
    if (latest.buffer === latest.disk.text) {
      setDoc((state) => (state && state.path === latest.path ? { ...state, disk, buffer: disk.text, gone: false } : state));
    } else {
      setDoc((state) => (state && state.path === latest.path && state.gone ? { ...state, gone: false } : state));
      setConflict(true);
    }
  }, [worktreeId]);

  // Another program may change the file while the window is in the background.
  useEffect(() => {
    const onFocus = () => void syncOpenDoc();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [syncOpenDoc]);

  // The files changed under the app (the core noticed it: a git command in a terminal, a file
  // made or deleted by another program): read again the views over them.
  const syncFromGit = useCallback(() => {
    loadTree(true);
    if (reference) {
      void openTarget(true);
    }
    void syncOpenDoc();
  }, [loadTree, reference, openTarget, syncOpenDoc]);
  const syncRef = useRef(syncFromGit);
  syncRef.current = syncFromGit;
  useEffect(() => {
    if (!worktreeId) {
      return;
    }
    // Bursts become one reload, and none runs while the space or the window cannot be seen.
    const scheduler = createSyncScheduler({
      run: () => syncRef.current(),
      canRun: () => !document.hidden && fileSection.current !== null && fileSection.current.offsetParent !== null,
    });
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenFilesChanged((id) => {
      if (id === worktreeId) {
        scheduler.request();
      }
    }).then((stop) => {
      if (disposed) {
        stop();
      } else {
        unlisten = stop;
      }
    });
    const resume = () => scheduler.resume();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    const seen =
      typeof IntersectionObserver === "function" && fileSection.current
        ? new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && scheduler.resume())
        : null;
    if (seen && fileSection.current) {
      seen.observe(fileSection.current);
    }
    return () => {
      disposed = true;
      unlisten?.();
      scheduler.dispose();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      seen?.disconnect();
    };
  }, [worktreeId]);

  // A new checkpoint (a comparison read again, a turn that ended) changes what the open file is
  // compared with: both sides are read again so the marks and the "edited since" notice are true.
  const checkpointId = checkpoint?.id ?? null;
  useEffect(() => {
    const current = docRef.current;
    if (!current || current.fixed) {
      return;
    }
    let cancelled = false;
    const inside = checkpoint?.files.some((file) => file.path === current.path) ?? false;
    void (async () => {
      try {
        const [head, base] =
          checkpoint && inside
            ? await Promise.all([codeFileAt(checkpoint.id, current.path, "head"), codeFileAt(checkpoint.id, current.path, "base")])
            : [null, null];
        if (cancelled) {
          return;
        }
        setDoc((state) =>
          state && state.path === current.path && (state.head !== head || state.base !== base) ? { ...state, head, base } : state,
        );
        if (!inside) {
          setVersion((now) => (now === "previous" && docRef.current?.disk ? "current" : now));
        }
      } catch {
        // The sides stay as they were; the next change reads them again.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only another checkpoint reads the sides again; opening a file reads them itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkpointId]);

  async function mark(state: ReviewState) {
    if (!checkpoint || !doc) {
      return;
    }
    try {
      const saved = await codeSetReviewMark(checkpoint.id, doc.path, state);
      setReview((view) =>
        view ? { ...view, marks: [...view.marks.filter((item) => item.path !== saved.path), saved] } : view,
      );
      onReviewChanged?.();
    } catch (err) {
      onError(errorText(err));
    }
  }

  async function refreshCheckpoint() {
    if (!sessionId) {
      return;
    }
    try {
      if (reference) {
        await openTarget();
        return;
      }
      await codeRefreshCheckpoint(sessionId, repositoryId);
      await loadReview(null);
    } catch (err) {
      onError(errorText(err));
    }
  }

  async function addComment(text: string) {
    if (!checkpoint || !doc) {
      return;
    }
    try {
      const line = selection.current?.line ?? null;
      const comment = await codeAddComment(
        checkpoint.id,
        doc.path,
        line,
        version === "previous" ? "base" : "head",
        text,
      );
      setReview((view) => (view ? { ...view, comments: [...view.comments, comment] } : view));
    } catch (err) {
      onError(errorText(err));
      throw err;
    }
  }

  // Shortcuts reach the space through the bridge: queue navigation, version toggle, comments.
  useEffect(() => {
    bridge.current.commands = {
      version: toggleVersion,
      wrap: toggleWrap,
      item: (delta) => {
        if (mode === "components" && units.length > 0) {
          const next = stepIn(units.map((unit) => unit.id), activeUnit, delta);
          const unit = units.find((item) => item.id === next);
          if (unit) {
            void openUnit(unit);
          }
          return;
        }
        const next = stepIn(queue, doc?.path ?? null, delta);
        if (next) {
          void openFile(next);
        }
      },
      comment: () => {
        if (!doc) {
          return;
        }
        if (!checkpoint || !inCheckpoint) {
          onError("Comments attach to a changed file of a checkpoint. Open a changed file first.");
          return;
        }
        setCommenting(true);
      },
    };
    return () => {
      bridge.current.commands = {};
    };
  }, [bridge, toggleVersion, toggleWrap, queue, units, mode, activeUnit, openUnit, doc, openFile, checkpoint, inCheckpoint, onError]);

  // What BTW is told about Code: the selection if there is one, else the component open in the
  // queue, else the file, whichever space BTW is summoned from.
  const contextOf = useCallback(
    (picked: EditorSelection | null) => {
      if (!doc) {
        return null;
      }
      if (picked?.text) {
        return { kind: "selection", label: doc.path, path: doc.path, startLine: picked.startLine, endLine: picked.endLine, text: picked.text };
      }
      const unit = units.find((item) => item.id === activeUnit && item.path === doc.path);
      if (unit) {
        return {
          kind: "component",
          label: `Component ${unit.container ? `${unit.container}.` : ""}${unit.name} (${unit.kind}, ${unit.level} priority) in ${doc.path}`,
          path: doc.path,
          startLine: unit.start_line,
          endLine: unit.end_line,
        };
      }
      return { kind: "file", label: doc.path, path: doc.path, startLine: picked?.startLine, endLine: picked?.endLine };
    },
    [doc, units, activeUnit],
  );
  useEffect(() => {
    bridge.current.context = contextOf(selection.current);
    return () => {
      bridge.current.context = null;
    };
  }, [bridge, contextOf]);

  const requestN = openRequest?.n;
  useEffect(() => {
    if (!openRequest) {
      return;
    }
    void openFile(openRequest.path).then(() => {
      if (openRequest.line) {
        const line = openRequest.line;
        setTimeout(() => editor.current?.reveal(Math.max(1, line - 3)), 120);
      }
    });
    // Only a new request opens a file; later renders must not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestN]);

  const shown = version === "previous" ? (doc?.base ?? "") : (doc?.buffer ?? "");
  const lineMarks: LineMarks = useMemo(() => {
    if (!doc || !inCheckpoint) {
      return { added: [], removed: [], commented: [] };
    }
    const unit = units.find((item) => item.id === activeUnit);
    const shownSide = version === "previous" ? "base" : "head";
    const unitRange =
      unit && unit.path === doc.path && unit.side === shownSide && unit.end_line > 0
        ? { start: unit.start_line, end: unit.end_line }
        : null;
    const changes = lineChanges(doc.base ?? "", doc.disk?.text ?? "");
    const side = version === "previous" ? "base" : "head";
    const commented = (review?.comments ?? [])
      .filter((comment) => comment.path === doc.path && comment.side === side && comment.line)
      .map((comment) => comment.line!);
    return version === "previous"
      ? { added: [], removed: changes.removed, commented, unitRange }
      : { added: dirty ? [] : changes.added, removed: [], commented, unitRange };
  }, [doc, inCheckpoint, version, review?.comments, dirty, units, activeUnit]);

  const comments = (review?.comments ?? []).filter((comment) => comment.path === doc?.path);
  const score = fileScore(priority, doc?.path ?? "");
  const noSession = !session;

  function listBody() {
    if (mode === "tree") {
      if (!worktree) {
        return <Empty text="Open a repository to browse its files." />;
      }
      if (treeState.kind === "loading") {
        return <Loading text="Reading the project files…" />;
      }
      if (treeState.kind === "failed") {
        return <Empty action={{ label: "Try again", onClick: () => loadTree() }} text={`Could not read the project files: ${treeState.message}`} />;
      }
      return (
        <ProjectTree
          changed={changeByPath}
          open={openFolders}
          openPath={doc?.path ?? null}
          paths={tree}
          onOpen={(path) => void openFile(path)}
          onToggle={(path) =>
            setOpenFolders((current) => {
              const next = new Set(current);
              if (!next.delete(path)) {
                next.add(path);
              }
              return next;
            })
          }
        />
      );
    }
    if (noSession) {
      return <Empty text="Open or start a chat: its changes are what gets reviewed here." />;
    }
    if (reviewState.kind === "loading") {
      return <Loading text="Loading the changes to review…" />;
    }
    if (reviewState.kind === "failed") {
      return (
        <Empty
          action={{
            label: "Try again",
            onClick: () => {
              setReviewState(LOADING);
              void openTarget();
            },
          }}
          text={`Could not load the changes: ${reviewState.message}`}
        />
      );
    }
    if (!checkpoint || files.length === 0 || !priority) {
      return (
        <Empty
          action={{ label: reference ? "Check again" : "Check for changes", onClick: () => void refreshCheckpoint() }}
          text={noDiffMessage(reference, compareProblem, worktree?.branch ?? null)}
        />
      );
    }
    return mode === "components" ? (
      <ComponentQueue
        activeUnit={activeUnit}
        openPath={doc?.path ?? null}
        marks={marks}
        priority={priority}
        onOpenFile={(path) => void openFile(path)}
        onOpenUnit={(unit) => void openUnit(unit)}
      />
    ) : (
      <ChangedList files={files} marks={marks} openPath={doc?.path ?? null} onOpen={(path) => void openFile(path)} />
    );
  }

  const state = marks.get(doc?.path ?? "");

  return (
    <div className="flex h-full min-h-0">
      <aside aria-label="Code navigator" className="flex w-[20.5rem] flex-none flex-col border-r border-cg-line bg-cg-sidebar">
        <div className="flex flex-col gap-2 px-3 pt-3 pb-2">
          {repositories.length > 1 && onSelectRepository ? (
            <RepositorySelect
              changes={changes}
              className="max-w-full text-ui font-semibold text-cg-ink"
              repositories={repositories}
              value={repositoryId}
              onChange={onSelectRepository}
            />
          ) : null}
          <Segmented<Mode> label="Navigator" options={MODES} value={mode} onChange={setMode} />
          {mode !== "tree" && session ? (
            <ShownRow
              hint={
                reference
                  ? "The current branch against the reference picked in the header, from where they split"
                  : "Nothing is compared until a branch or a commit is picked in the header. Until then, what the agent changed last."
              }
              refreshHint={reference ? "Compare again with the working tree as it is now" : "Record the working tree as a new checkpoint"}
              text={shownLabel(checkpoint, reference, worktree?.branch ?? null)}
              onRefresh={() => void refreshCheckpoint()}
            />
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{listBody()}</div>
      </aside>

      <section ref={fileSection} aria-label="File" className="flex min-w-0 flex-1 flex-col">
        {doc ? (
          <>
            <header className="flex h-10 flex-none items-center gap-3 border-b border-cg-line px-4">
              <span
                className="min-w-0 flex-1 truncate font-mono text-small text-cg-ink"
                title={dirty ? `${doc.path}: unsaved changes. Press Ctrl or Cmd S to save.` : doc.path}
              >
                {doc.path}
                {doc.gone ? <span> (removed)</span> : null}
                {dirty ? (
                  <>
                    <span aria-hidden="true"> *</span>
                    <span className="sr-only"> (unsaved changes)</span>
                  </>
                ) : null}
              </span>
              <div className="flex flex-none items-center gap-0.5">
                <Tip label={wrap ? "Lines are wrapped: let them run on (Alt+Z)" : "Wrap long lines (Alt+Z)"}>
                  <Button aria-label="Wrap long lines" aria-pressed={wrap} variant="icon" onClick={toggleWrap}>
                    <WrapText size={15} />
                  </Button>
                </Tip>
                {inCheckpoint ? (
                  <Tip
                    label={
                      !doc.disk
                        ? "This file was removed: only the previous version exists"
                        : !hasPrevious
                          ? "This file is new: there is no previous version"
                          : version === "previous"
                            ? "Back to the current version, which can be edited (Alt+V)"
                            : "Show how it was before, read-only (Alt+V)"
                    }
                  >
                    <Button
                      aria-label="Switch version"
                      aria-pressed={version === "previous"}
                      disabled={!hasPrevious || !doc.disk}
                      variant="icon"
                      onClick={toggleVersion}
                    >
                      <GitCompareArrows size={15} />
                    </Button>
                  </Tip>
                ) : null}
              </div>
            </header>

            {inCheckpoint ? (
              <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-cg-line bg-cg-sidebar px-4 py-1.5">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  <Chip>
                    {version === "previous"
                      ? (checkpoint?.base_label ?? "Previous version")
                      : doc.fixed
                        ? (checkpoint?.head_label ?? "Head")
                        : (checkpoint?.head_label ?? "Current version")}
                  </Chip>
                  {editedSince && version === "current" ? (
                    <Chip
                      tone="attention"
                      title="This file changed after the checkpoint was recorded. The marks compare the checkpoint's start with the file as it is now."
                    >
                      Edited since this checkpoint
                    </Chip>
                  ) : null}
                  {version === "previous" && !doc.fixed ? (
                    <Chip icon={<Lock aria-hidden="true" size={11} />} title="The previous version is the past: it cannot be edited">
                      Read-only
                    </Chip>
                  ) : null}
                  {doc.fixed ? (
                    <Chip
                      icon={<Lock aria-hidden="true" size={11} />}
                      title="A branch or commit cannot be edited. Compare against the working tree to edit."
                    >
                      Read-only
                    </Chip>
                  ) : null}
                  {score ? (
                    <span className="text-small text-cg-muted-strong" title={score.reasons.join(" · ")}>
                      {score.level === "high" ? "High" : score.level === "medium" ? "Medium" : "Low"} priority
                    </span>
                  ) : null}
                </div>
                <div aria-label="Review this file" className="flex flex-none items-center gap-1" role="group">
                  <Button
                    aria-pressed={state === "approved"}
                    variant="quiet"
                    onClick={() => void mark(state === "approved" ? "viewed" : "approved")}
                  >
                    <Check aria-hidden="true" className={state === "approved" ? "text-cg-green" : ""} size={13} />
                    {state === "approved" ? "Approved" : "Approve"}
                  </Button>
                  <Button
                    aria-pressed={state === "changes-requested"}
                    variant="quiet"
                    onClick={() => void mark(state === "changes-requested" ? "viewed" : "changes-requested")}
                  >
                    <CircleAlert aria-hidden="true" className={state === "changes-requested" ? "text-cg-red" : ""} size={13} />
                    {state === "changes-requested" ? "Changes requested" : "Needs changes"}
                  </Button>
                </div>
              </div>
            ) : null}

            {doc.gone ? (
              <div
                className="flex items-center gap-3 border-b border-cg-line bg-cg-accent-bg px-4 py-2 text-small text-cg-ink"
                data-testid="removed-banner"
                role="alert"
              >
                <span className="flex-1">
                  {dirty
                    ? "This file was removed from disk. Your unsaved edits are still here."
                    : "This file was removed from disk. Its last text is shown read-only."}
                </span>
                <Button variant="quiet" onClick={() => void save()}>
                  Write it again
                </Button>
                {dirty ? null : (
                  <Button variant="quiet" onClick={() => setDoc(null)}>
                    Close
                  </Button>
                )}
              </div>
            ) : null}

            {conflict ? (
              <div className="flex items-center gap-3 border-b border-cg-line bg-cg-accent-bg px-4 py-2 text-small text-cg-ink" role="alert">
                <span className="flex-1">This file changed on disk after you opened it.</span>
                <Button variant="quiet" onClick={() => void reloadFromDisk()}>
                  Reload from disk
                </Button>
                <Button variant="quiet" onClick={() => void save(true)}>
                  Overwrite
                </Button>
              </div>
            ) : null}

            {score && score.reasons.length > 0 && !(activeUnit && units.find((item) => item.id === activeUnit)?.path === doc.path) ? (
              <p
                aria-label="Why this ranks here"
                className="flex-none border-b border-cg-line bg-cg-sidebar px-4 py-1.5 text-small leading-5 text-cg-muted-strong"
              >
                <span className="text-cg-ink">{score.level} priority (score {score.score}).</span> {sentence(score.reasons.join(" · "))}
              </p>
            ) : null}

            {activeUnit && units.find((item) => item.id === activeUnit)?.path === doc.path ? (
              <UnitStrip
                unit={units.find((item) => item.id === activeUnit)!}
                onReset={
                  checkpoint
                    ? (unit) =>
                        void reviewResetPriority(checkpoint.id, unit.path, unit.name)
                          .then(() => loadReview(checkpoint.id))
                          .catch((err: unknown) => onError(errorText(err)))
                    : undefined
                }
              />
            ) : null}

            {comments.length > 0 ? (
              <ul aria-label="Comments on this file" className="flex max-h-[96px] flex-none flex-col overflow-y-auto border-b border-cg-line px-4 py-1.5">
                {comments.map((comment) => (
                  <li key={comment.id}>
                    <button
                      className="flex w-full items-baseline gap-2 py-0.5 text-left text-small text-cg-muted-strong hover:text-cg-ink"
                      type="button"
                      onClick={() => {
                        if (comment.side === "base" && version !== "previous") {
                          toggleVersion();
                        }
                        if (comment.line) {
                          editor.current?.reveal(Math.max(1, comment.line - 2));
                        }
                      }}
                    >
                      <span className="flex-none font-mono text-small text-cg-accent">
                        {comment.line ? `L${comment.line}` : "file"}
                      </span>
                      {comment.author === "agent" ? <Chip>Agent</Chip> : null}
                      <span className="min-w-0 flex-1 truncate">{comment.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="min-h-0 flex-1">
              {doc.disk?.binary ? (
                <Empty text="This file is binary." />
              ) : doc.disk?.tooLarge ? (
                <Empty text={`This file is too large to open (${Math.round(doc.disk.size / 1024)} KB).`} />
              ) : (
                <Suspense fallback={<Empty text="Loading the editor…" />}>
                  <MonacoEditor
                    docKey={version === "previous" ? `${checkpoint?.id}:${doc.path}@previous` : `${worktreeId}:${doc.path}`}
                    handleRef={editor}
                    language={languageFor(doc.path)}
                    marks={lineMarks}
                    readOnly={readOnly}
                    // Flipping to the past and back must not lose what was typed: the current version is the buffer.
                    value={version === "previous" ? shown : doc.buffer}
                    onBtw={onBtw}
                    onToggleVersion={toggleVersion}
                    onToggleWrap={toggleWrap}
                    wrap={wrap}
                    onChange={(text) =>
                      version === "current"
                        ? setDoc((state) => (state && state.path === doc.path ? { ...state, buffer: text } : state))
                        : undefined
                    }
                    onSave={() => void save()}
                    onSelection={(next) => {
                      selection.current = next;
                      bridge.current.context = contextOf(next);
                    }}
                  />
                </Suspense>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-8 text-center">
            <p className="max-w-[340px] text-small leading-6 text-cg-muted">
              {mode === "tree"
                ? "Pick a file to read or edit it."
                : "Pick a file from the list. Press Alt+V to flip between its current and previous version, J and K to step through the queue, and Ctrl/⌘+K to ask a BTW question about what you are reading."}
            </p>
          </div>
        )}
      </section>

      <CommentComposer
        isOpen={commenting}
        title={
          doc
            ? `${doc.path}${selection.current ? `:${selection.current.line}` : ""} · ${version === "previous" ? "previous version" : "current version"}`
            : "Comment"
        }
        onClose={() => setCommenting(false)}
        onSubmit={addComment}
      />
    </div>
  );
}

function Empty({
  text,
  action,
  secondary,
}: {
  text: string;
  action?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <p className="text-small leading-6 text-cg-muted">{text}</p>
      {action ? (
        <Button variant="quiet" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
      {secondary ? (
        <button className="text-small text-cg-muted hover:text-cg-ink" type="button" onClick={secondary.onClick}>
          {secondary.label}
        </button>
      ) : null}
    </div>
  );
}

/** A reason as the start of a sentence. */
function sentence(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Why the open unit is where it is in the queue. */
function UnitStrip({ unit, onReset }: { unit: Unit; onReset?: (unit: Unit) => void }) {
  const adjusted = (unit.factors ?? []).some((factor) => factor.component === "adjustment");
  return (
    <p
      aria-label="Why this ranks here"
      className="flex-none border-b border-cg-line bg-cg-sidebar px-4 py-1.5 text-small leading-5 text-cg-muted-strong"
    >
      <span className="font-mono text-small text-cg-ink">{unit.name}</span>{" "}
      <span className="text-cg-muted-strong">
        ({unit.kind}, {unit.level} priority, score {unit.score}).
      </span>{" "}
      <span className="text-cg-muted-strong">{sentence(unit.reasons.join(" · "))}</span>
      {adjusted && onReset ? (
        <>
          {" "}
          <button
            className="text-small font-medium text-cg-accent hover:underline"
            type="button"
            onClick={() => onReset(unit)}
          >
            Reset to the computed priority
          </button>
        </>
      ) : null}
    </p>
  );
}
