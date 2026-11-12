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
  theme: "light" | "dark";
  onClose: () => void;
};

const TERMINAL_FONT = '"Geist Mono Variable"';
const TERMINAL_FONT_STACK = `${TERMINAL_FONT}, "MesloLGS NF", "JetBrainsMono Nerd Font", "FiraCode Nerd Font", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
const TERMINAL_FONT_SIZE = 13;
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

  // xterm measures its cell size when it opens, so the web font has to be loaded first.
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    document.fonts
      .load(`${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT}`)
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setFontReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !fontReady) {
      return;
    }

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_STACK,
      fontSize: TERMINAL_FONT_SIZE,
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
          term.write(
            `\r\n\x1b[2m[process exited${payload.code == null ? "" : ` with code ${payload.code}`}]\x1b[0m\r\n`,
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
        term.write(
          `\x1b[2m[terminal unavailable: ${error instanceof Error ? error.message : String(error)}]\x1b[0m\r\n`,
        );
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
  }, [worktreeId, cwd, fontReady]);

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
      <header className="flex h-6 flex-none items-center justify-end px-4">
        <button
          aria-label="Close terminal"
          className="grid h-5 w-5 place-items-center text-[16px] leading-none text-cg-muted hover:text-cg-ink"
          type="button"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div ref={hostRef} className="min-h-0 flex-1 px-6 pb-2" />
    </section>
  );
}
