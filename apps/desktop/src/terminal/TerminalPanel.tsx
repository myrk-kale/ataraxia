import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  decodeTerminalBytes,
  encodeTerminalBytes,
  listenTerminalExit,
  listenTerminalOutput,
  terminalEnsure,
  terminalResize,
  terminalWrite,
  type PtySessionId,
} from "../lib/terminal";

type TerminalPanelProps = {
  worktreeId: string;
  cwd: string;
  context: string;
  theme: "light" | "dark";
  onClose: () => void;
};

const MIN_HEIGHT = 150;
const DEFAULT_HEIGHT = 245;

const XTERM_THEMES = {
  light: {
    background: "#fafaf9",
    foreground: "#50564f",
    cursor: "#7465a6",
    selectionBackground: "rgba(143, 126, 190, 0.23)",
  },
  dark: {
    background: "#111211",
    foreground: "#d9dbd6",
    cursor: "#a99cd8",
    selectionBackground: "rgba(169, 156, 216, 0.28)",
  },
} as const;

export function TerminalPanel({
  worktreeId,
  cwd,
  context,
  theme,
  onClose,
}: TerminalPanelProps) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<PtySessionId | null>(null);
  const [status, setStatus] = useState("starting…");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      theme: { ...XTERM_THEMES[themeRef.current] },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    term.attachCustomKeyEventHandler((event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        (event.key === "j" || event.key === "`")
      ) {
        return false;
      }
      return true;
    });

    let disposed = false;
    let unlistenOutput: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    async function boot() {
      try {
        const cols = Math.max(term.cols, 1);
        const rows = Math.max(term.rows, 1);
        const ensured = await terminalEnsure(worktreeId, cwd, cols, rows);
        if (disposed) {
          return;
        }
        sessionRef.current = ensured.sessionId;
        if (ensured.replay) {
          term.write(decodeTerminalBytes(ensured.replay));
        }
        setStatus(ensured.created ? "ready" : "reattached");

        unlistenOutput = await listenTerminalOutput((payload) => {
          if (payload.sessionId !== sessionRef.current) {
            return;
          }
          term.write(decodeTerminalBytes(payload.data));
        });
        unlistenExit = await listenTerminalExit((payload) => {
          if (payload.sessionId !== sessionRef.current) {
            return;
          }
          setStatus(
            payload.code == null ? "exited" : `exited (${payload.code})`,
          );
          sessionRef.current = null;
        });

        term.onData((data) => {
          const sessionId = sessionRef.current;
          if (!sessionId) {
            return;
          }
          void terminalWrite(sessionId, encodeTerminalBytes(data));
        });
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    }

    void boot();

    const observer = new ResizeObserver(() => {
      fit.fit();
      const sessionId = sessionRef.current;
      if (!sessionId) {
        return;
      }
      void terminalResize(sessionId, Math.max(term.cols, 1), Math.max(term.rows, 1));
    });
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      unlistenOutput?.();
      unlistenExit?.();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // Keep PTY alive on hide; do not kill here.
    };
  }, [worktreeId, cwd]);

  useEffect(() => {
    const term = termRef.current;
    if (term) {
      term.options.theme = { ...XTERM_THEMES[theme] };
    }
  }, [theme]);

  // Drag the top edge to resize; pointer capture keeps the drag alive outside the grip.
  function onGripDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = height;
    const max = Math.round(window.innerHeight * 0.68);
    function onMove(move: globalThis.PointerEvent) {
      const next = startHeight + (startY - move.clientY);
      setHeight(Math.min(max, Math.max(MIN_HEIGHT, next)));
    }
    function onUp(up: globalThis.PointerEvent) {
      grip.releasePointerCapture(up.pointerId);
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
    }
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
  }

  const background = XTERM_THEMES[theme].background;

  return (
    <section
      aria-label="Terminal"
      className="relative flex flex-none flex-col overflow-hidden border-t border-cg-line-strong"
      style={{ height, background }}
    >
      <div
        aria-hidden="true"
        className="group relative h-[5px] flex-none cursor-ns-resize"
        onPointerDown={onGripDown}
      >
        <span className="absolute top-0 left-1/2 h-0.5 w-11 -translate-x-1/2 rounded-sm bg-cg-line-strong group-hover:bg-cg-muted" />
      </div>
      <header className="flex h-[39px] flex-none items-center gap-3.5 border-b border-cg-line px-6">
        <span className="text-micro font-bold tracking-[1px] text-cg-muted-strong">TERMINAL</span>
        <span className="min-w-0 truncate text-micro text-cg-muted">
          {context} · {shortPath(cwd)} · {status}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-micro text-cg-muted">Ctrl + `</span>
        <button
          aria-label="Close terminal"
          className="grid h-[25px] w-[25px] place-items-center text-[20px] leading-none text-cg-muted hover:text-cg-ink"
          type="button"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div ref={hostRef} className="min-h-0 flex-1 px-6 pt-2 pb-2" />
    </section>
  );
}

function shortPath(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) {
    return path;
  }
  return parts.slice(-2).join("/");
}
