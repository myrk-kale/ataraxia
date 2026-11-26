import { Bug, ChevronDown, Copy, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  browserClearLogs,
  browserDevtools,
  browserLogs,
  browserRequestAs,
  type BrowserTab,
  type LogView,
  type NetEntry,
} from "../lib/browser";
import { Button } from "../ui/Button";
import {
  clock,
  consoleLines,
  failed,
  filterConsole,
  filterNet,
  formatBytes,
  formatDuration,
  prettyBody,
  requestName,
  statusLabel,
  statusTone,
  type ConsoleLevel,
  type StatusTone,
} from "./model";

const EMPTY: LogView = { console: [], errors: [], net: [], mark: 0 };

/** The log of a tab, read every second while the panel is open. */
export function useLogs(tab: number | null, open: boolean): [LogView, () => void] {
  const [logs, setLogs] = useState<LogView>(EMPTY);
  const read = useCallback(() => {
    if (tab === null) {
      setLogs(EMPTY);
      return;
    }
    browserLogs(tab).then(
      (next) => setLogs((known) => (known.mark === next.mark && known.net.length === next.net.length && known.net.every((entry, i) => entry.done === next.net[i]?.done) ? known : next)),
      () => undefined,
    );
  }, [tab]);
  useEffect(() => {
    setLogs(EMPTY);
    if (!open || tab === null) {
      return;
    }
    read();
    const timer = window.setInterval(read, 1000);
    return () => window.clearInterval(timer);
  }, [tab, open, read]);
  return [logs, read];
}

const TONE: Record<StatusTone, string> = {
  pending: "text-cg-muted",
  ok: "text-cg-ink",
  redirect: "text-cg-muted-strong",
  client: "text-cg-red",
  server: "text-cg-red",
  failed: "text-cg-red",
};

const LEVEL_STYLE: Record<string, string> = {
  error: "text-cg-red",
  warn: "text-cg-amber",
  info: "text-cg-muted-strong",
  debug: "text-cg-muted",
  log: "text-cg-ink",
};

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      aria-pressed={active}
      className={`rounded-cg-sm border px-2 py-0.5 text-small ${active ? "border-cg-line-strong bg-cg-tint text-cg-ink" : "border-transparent text-cg-muted-strong hover:bg-cg-tint"}`}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ConsoleList({ logs }: { logs: LogView }) {
  const [level, setLevel] = useState<ConsoleLevel>("all");
  const [text, setText] = useState("");
  const lines = useMemo(() => filterConsole(consoleLines(logs.console, logs.errors), level, text), [logs, level, text]);
  const box = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useEffect(() => {
    const element = box.current;
    if (element && stuck.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lines]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-cg-line px-2 py-1">
        {(["all", "error", "warn", "info", "log"] as const).map((item) => (
          <Chip key={item} active={level === item} onClick={() => setLevel(item)}>
            {item === "all" ? "All" : item[0]!.toUpperCase() + item.slice(1)}
          </Chip>
        ))}
        <input
          aria-label="Filter the console"
          className="ml-2 h-6 min-w-0 flex-1 rounded-cg-sm border border-cg-line bg-cg-panel px-2 text-small text-cg-ink placeholder:text-cg-muted"
          placeholder="Filter"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <div
        ref={box}
        aria-label="Console"
        className="min-h-0 flex-1 overflow-auto font-mono text-small leading-5"
        role="log"
        onScroll={(event) => {
          const el = event.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.length === 0 ? <p className="p-3 font-sans text-cg-muted">Nothing logged{level === "all" && !text ? " yet" : " with this filter"}.</p> : null}
        {lines.map((line) => (
          <div key={line.seq} className={`border-b border-cg-line px-3 py-1 ${line.level === "error" ? "bg-cg-red/5" : line.level === "warn" ? "bg-cg-amber/5" : ""}`}>
            <span className="mr-2 text-cg-muted">{clock(line.t)}</span>
            <span className={`whitespace-pre-wrap break-words ${LEVEL_STYLE[line.level]}`}>{line.text}</span>
            {line.detail ? <pre className="mt-0.5 overflow-x-auto pl-14 text-cg-muted">{line.detail}</pre> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-cg-line px-3 py-2">
      <h4 className="mb-1 text-small font-semibold text-cg-muted-strong">{title}</h4>
      {children}
    </section>
  );
}

function Headers({ headers }: { headers: Record<string, string> }) {
  const names = Object.keys(headers).sort();
  if (names.length === 0) {
    return <p className="text-cg-muted">None captured.</p>;
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-small">
      {names.map((name) => (
        <div key={name} className="contents">
          <dt className="text-cg-muted-strong">{name}</dt>
          <dd className="break-all text-cg-ink">{headers[name]}</dd>
        </div>
      ))}
    </dl>
  );
}

function RequestDetail({ tab, entry, onClose }: { tab: number; entry: NetEntry; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(form: "curl" | "fetch") {
    try {
      await navigator.clipboard.writeText(await browserRequestAs(tab, entry.id, form));
      setCopied(form);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }
  return (
    <aside aria-label="Request details" className="flex min-h-0 w-[46%] min-w-[280px] flex-col border-l border-cg-line">
      <div className="flex items-center gap-2 border-b border-cg-line px-3 py-1.5">
        <span className={`font-mono text-small font-semibold ${TONE[statusTone(entry)]}`}>{entry.method}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-small text-cg-ink" title={entry.url}>
          {entry.url}
        </span>
        <Button size="sm" variant="quiet" onClick={() => void copy("curl")}>
          <Copy aria-hidden="true" size={12} />
          {copied === "curl" ? "Copied" : "cURL"}
        </Button>
        <Button size="sm" variant="quiet" onClick={() => void copy("fetch")}>
          <Copy aria-hidden="true" size={12} />
          {copied === "fetch" ? "Copied" : "fetch"}
        </Button>
        <Button aria-label="Close details" variant="icon" onClick={onClose}>
          <X aria-hidden="true" size={13} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto text-small">
        <Section title="General">
          <p className="font-mono text-cg-ink">
            {statusLabel(entry)} {entry.statusText ?? ""} · {entry.kind} · {formatDuration(entry.duration) || "…"} {entry.resSize ? `· ${formatBytes(entry.resSize)}` : ""}
          </p>
          {entry.error ? <p className="font-mono text-cg-red">{entry.error}</p> : null}
          {entry.finalUrl ? <p className="font-mono text-cg-muted-strong">redirected to {entry.finalUrl}</p> : null}
          {entry.initiator ? <p className="font-mono text-cg-muted">from {entry.initiator}</p> : null}
        </Section>
        <Section title="Request headers">
          <Headers headers={entry.reqHeaders} />
        </Section>
        {entry.reqBody || entry.reqNote ? (
          <Section title="Request body">
            <pre className="overflow-x-auto font-mono whitespace-pre-wrap text-cg-ink">{prettyBody(entry.reqBody) || entry.reqNote}</pre>
          </Section>
        ) : null}
        <Section title="Response headers">
          <Headers headers={entry.resHeaders} />
        </Section>
        <Section title={`Response body${entry.resTruncated ? " (cut)" : ""}`}>
          {entry.frames.length > 0 ? (
            <ul className="font-mono">
              {entry.frames.map((frame, index) => (
                <li key={index} className="break-all text-cg-ink">
                  <span className="text-cg-muted">{frame.d === "in" ? "← " : "→ "}</span>
                  {frame.data}
                </li>
              ))}
            </ul>
          ) : entry.resBody ? (
            <pre className="overflow-x-auto font-mono whitespace-pre-wrap text-cg-ink">{prettyBody(entry.resBody)}</pre>
          ) : (
            <p className="text-cg-muted">{entry.resNote ?? "Not captured."}</p>
          )}
        </Section>
      </div>
    </aside>
  );
}

function NetworkList({ tab, logs }: { tab: number; logs: LogView }) {
  const [text, setText] = useState("");
  const [apiOnly, setApiOnly] = useState(true);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const rows = useMemo(() => filterNet(logs.net, { text, apiOnly, onlyFailed }), [logs.net, text, apiOnly, onlyFailed]);
  const entry = logs.net.find((item) => item.id === selected) ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-cg-line px-2 py-1">
        <Chip active={apiOnly} onClick={() => setApiOnly((on) => !on)}>
          Fetch / XHR
        </Chip>
        <Chip active={onlyFailed} onClick={() => setOnlyFailed((on) => !on)}>
          Failed
        </Chip>
        <input
          aria-label="Filter requests"
          className="ml-2 h-6 min-w-0 flex-1 rounded-cg-sm border border-cg-line bg-cg-panel px-2 text-small text-cg-ink placeholder:text-cg-muted"
          placeholder="Filter by address, method, status or type"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <span className="px-1 text-small text-cg-muted tabular-nums">{rows.length}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto" role="table" aria-label="Requests">
          <div className="sticky top-0 grid grid-cols-[52px_52px_minmax(0,1fr)_96px_70px_70px] gap-2 border-b border-cg-line bg-cg-panel px-3 py-1 text-small font-semibold text-cg-muted-strong" role="row">
            <span>Status</span>
            <span>Method</span>
            <span>Name</span>
            <span>Type</span>
            <span className="text-right">Time</span>
            <span className="text-right">Size</span>
          </div>
          {rows.length === 0 ? <p className="p-3 text-small text-cg-muted">No requests{text || onlyFailed ? " match" : apiOnly ? " yet: the page has made no fetch or XHR call" : " yet"}.</p> : null}
          {rows.map((row) => (
            <button
              key={row.id}
              aria-selected={row.id === selected}
              className={`grid w-full grid-cols-[52px_52px_minmax(0,1fr)_96px_70px_70px] gap-2 border-b border-cg-line px-3 py-1 text-left font-mono text-small hover:bg-cg-tint ${row.id === selected ? "bg-cg-tint" : ""} ${failed(row) ? "bg-cg-red/5" : ""}`}
              role="row"
              type="button"
              onClick={() => setSelected(row.id === selected ? null : row.id)}
            >
              <span className={TONE[statusTone(row)]}>{statusLabel(row)}</span>
              <span className="text-cg-muted-strong">{row.method}</span>
              <span className="truncate text-cg-ink" title={row.url}>
                {requestName(row)}
              </span>
              <span className="truncate text-cg-muted">{row.mime ?? row.kind}</span>
              <span className="text-right text-cg-muted">{formatDuration(row.duration)}</span>
              <span className="text-right text-cg-muted">{formatBytes(row.resSize)}</span>
            </button>
          ))}
        </div>
        {entry ? <RequestDetail entry={entry} tab={tab} onClose={() => setSelected(null)} /> : null}
      </div>
    </div>
  );
}

/**
 * The page's console and network, kept across its navigations: what a browser's developer tools
 * show first. An agent reads the same logs through its own tools, so the developer and the agent
 * look at the same evidence.
 */
export function DebugPanel({
  tab,
  height,
  onResize,
  onClose,
}: {
  tab: BrowserTab;
  height: number;
  onResize: (height: number) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<"console" | "network">("console");
  const [logs, reload] = useLogs(tab.id, true);
  const drag = useRef<{ y: number; h: number } | null>(null);
  const errors = logs.console.filter((entry) => entry.level === "error").length + logs.errors.length;
  const failedCount = logs.net.filter(failed).length;

  return (
    <section aria-label="Developer tools" className="flex flex-none flex-col border-t border-cg-line-strong bg-cg-panel" style={{ height }}>
      <div
        aria-label="Resize the panel"
        aria-orientation="horizontal"
        aria-valuemax={720}
        aria-valuemin={140}
        aria-valuenow={Math.round(height)}
        className="h-1.5 flex-none cursor-row-resize hover:bg-cg-line-strong"
        role="separator"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") onResize(Math.min(720, height + 24));
          if (event.key === "ArrowDown") onResize(Math.max(140, height - 24));
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { y: event.clientY, h: height };
        }}
        onPointerMove={(event) => {
          if (drag.current) {
            onResize(Math.min(720, Math.max(140, drag.current.h + drag.current.y - event.clientY)));
          }
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      />
      <div className="flex flex-none items-center gap-1 border-b border-cg-line px-2 py-1">
        <Bug aria-hidden="true" className="mx-1 text-cg-muted" size={14} />
        <Chip active={view === "console"} onClick={() => setView("console")}>
          Console{errors > 0 ? <span className="ml-1 text-cg-red tabular-nums">{errors}</span> : null}
        </Chip>
        <Chip active={view === "network"} onClick={() => setView("network")}>
          Network<span className="ml-1 text-cg-muted tabular-nums">{logs.net.filter((entry) => ["fetch", "xhr", "ws"].includes(entry.kind)).length}</span>
          {failedCount > 0 ? <span className="ml-1 text-cg-red tabular-nums">{failedCount}</span> : null}
        </Chip>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="quiet"
          onClick={() => {
            void browserClearLogs(tab.id).then(reload, () => undefined);
          }}
        >
          <Trash2 aria-hidden="true" size={12} />
          Clear
        </Button>
        <Button size="sm" variant="quiet" title="Open the browser's own inspector for this page" onClick={() => void browserDevtools(tab.id).catch(() => undefined)}>
          Inspector
        </Button>
        <Button aria-label="Close developer tools" variant="icon" onClick={onClose}>
          <ChevronDown aria-hidden="true" size={14} />
        </Button>
      </div>
      {view === "console" ? <ConsoleList logs={logs} /> : <NetworkList logs={logs} tab={tab.id} />}
    </section>
  );
}
