import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
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
};

export function TerminalPanel({ worktreeId, cwd }: TerminalPanelProps) {
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
      theme: {
        background: "#111113",
        foreground: "#e8e8ea",
      },
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

  return (
    <section className="flex h-48 flex-col border-t border-foreground/10 bg-[#111113]">
      <div className="flex items-center justify-between px-3 py-1 text-[11px] uppercase tracking-[0.14em] text-foreground/45">
        <span>Terminal</span>
        <span className="normal-case tracking-normal text-foreground/55">
          {shortPath(cwd)} · {status}
        </span>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-2 pb-2" />
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
