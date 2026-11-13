import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import "@xterm/xterm/css/xterm.css";
import { familyFor } from "../app/appearance/fonts";
import { useAppearance } from "../app/appearance/store";
import { isTerminalToggle } from "../app/shortcuts";
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
import { currentFocus, restoreFocus } from "./focus";

type TerminalPanelProps = {
  worktreeId: string;
  cwd: string;
  onClose: () => void;
};

const MIN_HEIGHT = 150;
const DEFAULT_HEIGHT = 245;

const XTERM_THEMES = {
  light: {
    background: "#fafaf9",
    foreground: "#50564f",
    cursor: "#665698",
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
  onClose,
}: TerminalPanelProps) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const appearance = useAppearance();
  // An imported theme brings its own palette; the built-in ones keep theirs.
  const palette = appearance.custom ? { ...appearance.custom.terminal } : { ...XTERM_THEMES[appearance.kind] };
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const fontRef = useRef(appearance.fonts.terminal);
  fontRef.current = appearance.fonts.terminal;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<PtySessionId | null>(null);

  // Remember what had focus when the panel opened and give it back when the panel closes.
  // The panel is unmounted on hide (the PTY lives on), so mount and unmount are open and close.
  useEffect(() => {
    const previous = currentFocus();
    return () => restoreFocus(previous);
  }, []);

  // xterm measures its cell size when it opens, so the web font has to be loaded first.
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    document.fonts
      .load(`${fontRef.current.size}px ${familyFor("terminal", fontRef.current)}`)
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
      fontFamily: familyFor("terminal", fontRef.current),
      fontSize: fontRef.current.size,
      theme: paletteRef.current,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // The terminal shortcut goes to the app, not into the shell.
    term.attachCustomKeyEventHandler((event) => !isTerminalToggle(event));
    // Typing works with no click. Opened after the font is ready and fitted.
    term.focus();

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

  const paletteKey = JSON.stringify(palette);
  useEffect(() => {
    const term = termRef.current;
    if (term) {
      term.options.theme = paletteRef.current;
    }
  }, [paletteKey]);

  // A new face or size changes the size of a cell, so the grid is fitted again.
  const terminalFont = appearance.fonts.terminal;
  useEffect(() => {
    const term = termRef.current;
    if (term) {
      term.options.fontFamily = familyFor("terminal", terminalFont);
      term.options.fontSize = terminalFont.size;
      fitRef.current?.fit();
    }
  }, [terminalFont]);

  function maxHeight(): number {
    return Math.round(window.innerHeight * 0.68);
  }

  // The same resize from the keyboard: arrows nudge the height, Home and End jump to the limits.
  function onGripKey(event: KeyboardEvent<HTMLDivElement>) {
    const steps: Record<string, number> = { ArrowUp: 24, ArrowDown: -24 };
    const max = maxHeight();
    if (event.key in steps) {
      event.preventDefault();
      setHeight((now) => Math.min(max, Math.max(MIN_HEIGHT, now + steps[event.key]!)));
    } else if (event.key === "Home") {
      event.preventDefault();
      setHeight(MIN_HEIGHT);
    } else if (event.key === "End") {
      event.preventDefault();
      setHeight(max);
    }
  }

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

  const background = palette.background;

  return (
    <section
      aria-label="Terminal"
      className="relative flex flex-none flex-col overflow-hidden border-t border-cg-control"
      style={{ height, background }}
    >
      <div
        aria-label="Resize terminal. Arrow keys change the height."
        aria-orientation="horizontal"
        aria-valuemax={maxHeight()}
        aria-valuemin={MIN_HEIGHT}
        aria-valuenow={height}
        className="group relative h-2 flex-none cursor-ns-resize"
        role="separator"
        tabIndex={0}
        onKeyDown={onGripKey}
        onPointerDown={onGripDown}
      >
        <span className="absolute top-0.5 left-1/2 h-0.5 w-11 -translate-x-1/2 rounded-cg-sm bg-cg-control group-hover:bg-cg-muted-strong" />
      </div>
      <header className="flex h-6 flex-none items-center justify-end px-4">
        <button
          aria-label="Close terminal"
          className="grid h-6 w-6 place-items-center rounded-cg-sm text-cg-muted-strong hover:bg-cg-tint hover:text-cg-ink"
          type="button"
          onClick={onClose}
        >
          <X aria-hidden="true" size={14} />
        </button>
      </header>
      <div ref={hostRef} className="min-h-0 flex-1 px-6 pb-2" />
    </section>
  );
}
