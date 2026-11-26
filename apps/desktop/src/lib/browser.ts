import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";

/** A tab of the built-in browser, as the app keeps it. */
export type BrowserTab = {
  id: number;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  favicon: string | null;
  /** `agent` tabs use a store of cookies of their own, apart from the developer's. */
  profile: "user" | "agent";
  /** Whether an agent may look at and act on this tab. */
  agentControl: boolean;
  errors: number;
  failedRequests: number;
  loadError: string | null;
};

export type BrowserState = {
  tabs: BrowserTab[];
  active: number | null;
  agentsAllowed: boolean;
};

/** An agent doing something in a tab, or having just stopped. */
export type AgentActivity = { tab: number; busy: boolean; action: string };

export type ConsoleEntry = { seq: number; level: string; text: string; t: number; page: string };
export type PageError = {
  seq: number;
  kind: string;
  message: string;
  t: number;
  page: string;
  source?: string | null;
  line?: number | null;
  column?: number | null;
  stack?: string | null;
  url?: string | null;
};
export type NetEntry = {
  id: string;
  /** fetch, xhr, ws, or resource (an image, script... the page loaded by itself). */
  kind: string;
  method: string;
  url: string;
  finalUrl?: string | null;
  page: string;
  t: number;
  status: number;
  statusText?: string | null;
  ok?: boolean | null;
  done: boolean;
  duration?: number | null;
  reqHeaders: Record<string, string>;
  reqBody?: string | null;
  reqNote?: string | null;
  resHeaders: Record<string, string>;
  resBody?: string | null;
  resNote?: string | null;
  resTruncated: boolean;
  resSize?: number | null;
  mime?: string | null;
  error?: string | null;
  initiator?: string | null;
  frames: { d: string; t: number; data: string }[];
  seq: number;
};
export type LogView = { console: ConsoleEntry[]; errors: PageError[]; net: NetEntry[]; mark: number };

const EMPTY: BrowserState = { tabs: [], active: null, agentsAllowed: true };

// One copy for the window: the browser space, its debug panel and the notice that an agent is at
// work all read the same thing, and an event from the app updates them together.
let current: BrowserState = EMPTY;
let activity: AgentActivity | null = null;
let started = false;
const listeners = new Set<() => void>();

function publish() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reads the browser and follows its events. Called by the first component that needs either. */
export function startBrowser(): void {
  if (started) {
    return;
  }
  started = true;
  void listen<
    { type: "tabs"; tabs: BrowserTab[]; active: number | null } | ({ type: "agent" } & AgentActivity)
  >("browser://event", (event) => {
    const payload = event.payload;
    if (payload.type === "tabs") {
      current = { ...current, tabs: payload.tabs, active: payload.active };
    } else {
      activity = payload.busy ? { tab: payload.tab, busy: true, action: payload.action } : null;
    }
    publish();
  }).catch(() => {
    started = false;
  });
  void invoke<BrowserState>("browser_state")
    .then((state) => {
      current = state;
      publish();
    })
    .catch(() => {
      // Outside the app (a browser tab running the interface) there is no browser to read.
    });
}

export function useBrowser(): BrowserState {
  useEffect(startBrowser, []);
  return useSyncExternalStore(subscribe, () => current);
}

export function useAgentActivity(): AgentActivity | null {
  useEffect(startBrowser, []);
  return useSyncExternalStore(subscribe, () => activity);
}

export const browserOpen = (url?: string) => invoke<BrowserTab>("browser_open", { url: url ?? null });
export const browserClose = (id: number) => invoke<void>("browser_close", { id });
export const browserActivate = (id: number) => invoke<void>("browser_activate", { id });
export const browserNavigate = (id: number, input: string) => invoke<string>("browser_navigate", { id, input });
export const browserGo = (id: number, movement: "back" | "forward" | "reload") => invoke<void>("browser_go", { id, movement });
export const browserStop = (id: number) => invoke<void>("browser_stop", { id });
export const browserSetBounds = (x: number, y: number, width: number, height: number) =>
  invoke<void>("browser_set_bounds", { x, y, width, height });
export const browserSetVisible = (visible: boolean) => invoke<void>("browser_set_visible", { visible });
export const browserSetAgentControl = (id: number, allowed: boolean) =>
  invoke<void>("browser_set_agent_control", { id, allowed });
export const browserSetAgentsAllowed = (allowed: boolean) => invoke<void>("browser_set_agents_allowed", { allowed });
export const browserLogs = (id: number) => invoke<LogView>("browser_logs", { id });
export const browserClearLogs = (id: number) => invoke<void>("browser_clear_logs", { id });
export const browserRequestAs = (id: number, request: string, form: "curl" | "fetch") =>
  invoke<string>("browser_request_as", { id, request, form });
export const browserDevtools = (id: number) => invoke<void>("browser_devtools", { id });
export const browserScreenshot = (id: number) => invoke<string>("browser_screenshot", { id });
export const browserClearData = (profile: "user" | "agent") => invoke<void>("browser_clear_data", { profile });

/** Test hook: a fresh state, as at start. */
export function resetBrowserForTests(state: BrowserState = EMPTY, agent: AgentActivity | null = null) {
  current = state;
  activity = agent;
  started = true;
  publish();
}
