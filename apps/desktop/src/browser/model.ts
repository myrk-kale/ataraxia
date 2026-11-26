import type { BrowserTab, ConsoleEntry, NetEntry, PageError } from "../lib/browser";

/** The address of a tab as one reads it: without the scheme and the trailing slash. */
export function displayAddress(url: string): string {
  if (!url || url === "about:blank") {
    return "";
  }
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The words on a tab: its title, else its address, else that it is new. */
export function tabLabel(tab: Pick<BrowserTab, "title" | "url">): string {
  return tab.title.trim() || displayAddress(tab.url) || "New tab";
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) {
    return "";
  }
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} kB`;
  }
  return `${bytes} B`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) {
    return "";
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

/** Whether a request failed: it never answered, or the answer was an error. */
export function failed(entry: NetEntry): boolean {
  if (entry.error) {
    return true;
  }
  if (!entry.done || entry.kind === "ws") {
    return false;
  }
  if (entry.kind === "resource") {
    return entry.status >= 400;
  }
  return entry.status >= 400 || entry.status === 0;
}

export type StatusTone = "pending" | "ok" | "redirect" | "client" | "server" | "failed";

export function statusTone(entry: NetEntry): StatusTone {
  if (entry.error) {
    return "failed";
  }
  if (!entry.done) {
    return "pending";
  }
  if (entry.status >= 500) {
    return "server";
  }
  if (entry.status >= 400) {
    return "client";
  }
  if (entry.status >= 300) {
    return "redirect";
  }
  if (entry.status === 0 && entry.kind !== "ws" && entry.kind !== "resource") {
    return "failed";
  }
  return "ok";
}

export function statusLabel(entry: NetEntry): string {
  if (entry.error) {
    return "failed";
  }
  if (!entry.done) {
    return "…";
  }
  return entry.status > 0 ? String(entry.status) : entry.kind === "ws" ? "ws" : "–";
}

/** What a request is called in a list: its path and query, with the host when it is not the page's. */
export function requestName(entry: Pick<NetEntry, "url" | "page">): string {
  try {
    const url = new URL(entry.url);
    const page = (() => {
      try {
        return new URL(entry.page).host;
      } catch {
        return "";
      }
    })();
    const name = `${url.pathname}${url.search}` || "/";
    return url.host === page ? name : `${url.host}${name}`;
  } catch {
    return entry.url;
  }
}

export type NetFilter = {
  text: string;
  /** Only the page's own calls (fetch, XHR, WebSocket), not the files it loaded. */
  apiOnly: boolean;
  onlyFailed: boolean;
};

export function filterNet(entries: readonly NetEntry[], filter: NetFilter): NetEntry[] {
  const needle = filter.text.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filter.apiOnly && !["fetch", "xhr", "ws"].includes(entry.kind)) {
      return false;
    }
    if (filter.onlyFailed && !failed(entry)) {
      return false;
    }
    if (needle) {
      const haystack = `${entry.method} ${entry.url} ${entry.status} ${entry.mime ?? ""}`.toLowerCase();
      return needle.split(/\s+/).every((word) => haystack.includes(word));
    }
    return true;
  });
}

export type ConsoleLevel = "all" | "error" | "warn" | "info" | "log" | "debug";

/** The console's lines and the page's uncaught errors as one list, oldest first. */
export type ConsoleLine = {
  seq: number;
  level: "error" | "warn" | "info" | "log" | "debug";
  text: string;
  detail?: string;
  t: number;
  uncaught: boolean;
};

export function consoleLines(console_: readonly ConsoleEntry[], errors: readonly PageError[]): ConsoleLine[] {
  const lines: ConsoleLine[] = console_.map((entry) => ({
    seq: entry.seq,
    level: (["error", "warn", "info", "debug"].includes(entry.level) ? entry.level : "log") as ConsoleLine["level"],
    text: entry.text,
    t: entry.t,
    uncaught: false,
  }));
  for (const entry of errors) {
    const place = entry.source ? ` (${entry.source}:${entry.line ?? 0}:${entry.column ?? 0})` : "";
    lines.push({
      seq: entry.seq,
      level: "error",
      text: `${entry.message}${place}`,
      detail: entry.stack ?? undefined,
      t: entry.t,
      uncaught: true,
    });
  }
  return lines.sort((a, b) => a.seq - b.seq);
}

export function filterConsole(lines: readonly ConsoleLine[], level: ConsoleLevel, text: string): ConsoleLine[] {
  const needle = text.trim().toLowerCase();
  return lines.filter((line) => {
    if (level !== "all" && line.level !== level && !(level === "log" && line.level === "info")) {
      return false;
    }
    return !needle || line.text.toLowerCase().includes(needle);
  });
}

/** A JSON text, indented; anything else as it is. */
export function prettyBody(body: string | null | undefined): string {
  if (!body) {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** The clock time of a log line. */
export function clock(t: number): string {
  const date = new Date(t);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** The first thing the address bar is given when nothing is typed yet. */
export const START_PAGES: readonly { label: string; url: string }[] = [
  { label: "DuckDuckGo", url: "https://duckduckgo.com" },
  { label: "GitHub", url: "https://github.com" },
  { label: "MDN", url: "https://developer.mozilla.org" },
  { label: "localhost:3000", url: "http://localhost:3000" },
];
