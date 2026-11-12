import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ChatSession, ProviderKind, SessionId, SessionStatus } from "./workspace";

export type ChatRole = "user" | "assistant" | "system";
export type ToolStatus = "running" | "done" | "failed";

export type ChatMessage = {
  kind: "message";
  id: string;
  role: ChatRole;
  text: string;
  turnId: string | null;
};

export type ToolItem = {
  kind: "tool";
  callId: string;
  turnId: string;
  name: string;
  input: string;
  output: string | null;
  status: ToolStatus;
};

export type ChatItem = ChatMessage | ToolItem;

export type PendingPermission = {
  requestId: string;
  turnId: string;
  toolName: string;
  detail: string;
};

export type SubagentStatus = "running" | "done" | "failed";

/** A subagent's own conversation, read-only in the UI. */
export type SubagentView = {
  id: string;
  title: string;
  status: SubagentStatus;
  /** Keeps running after the turn that started it ends (a background subagent). */
  detached?: boolean;
  items: ChatItem[];
};

export type SubagentUpdate =
  | { kind: "started" }
  | { kind: "detached" }
  | { kind: "user"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "tool"; callId: string; name: string; input: string }
  | { kind: "toolResult"; callId: string; output: string; ok: boolean }
  | { kind: "done"; ok: boolean };

export type ChatSnapshot = {
  items: ChatItem[];
  subagents: SubagentView[];
  restoredCount: number;
  status: SessionStatus;
  pendingPermission: PendingPermission | null;
};

export type AgentEvent =
  | { type: "status"; sessionId: SessionId; status: SessionStatus }
  | {
      type: "delta";
      sessionId: SessionId;
      turnId: string;
      role: ChatRole;
      text: string;
    }
  | {
      type: "tool";
      sessionId: SessionId;
      turnId: string;
      callId: string;
      name: string;
      input: string;
    }
  | {
      type: "toolUpdate";
      sessionId: SessionId;
      turnId: string;
      callId: string;
      name: string | null;
      input: string | null;
    }
  | {
      type: "toolResult";
      sessionId: SessionId;
      turnId: string;
      callId: string;
      output: string;
      ok: boolean;
    }
  | {
      type: "permission";
      sessionId: SessionId;
      turnId: string;
      requestId: string;
      toolName: string;
      detail: string;
    }
  | { type: "turnDone"; sessionId: SessionId; turnId: string; ok: boolean }
  | {
      type: "subagent";
      sessionId: SessionId;
      subagentId: string;
      title: string;
      update: SubagentUpdate;
    }
  | { type: "error"; sessionId: SessionId; message: string };

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  fake: "Fake",
  opencode: "OpenCode",
  claude: "Claude Code",
  codex: "Codex",
};

export type ModelChoice = {
  id: string;
  label: string;
  /** Effort levels this model supports; empty means the session-wide list applies. */
  efforts: string[];
};

export type AgentChoice = { id: string; label: string; description: string | null };

/** What a live session offers right now, discovered from the provider. */
export type SessionOptions = {
  models: ModelChoice[];
  default_model: string | null;
  efforts: string[];
  agents: AgentChoice[];
};

export type ProviderSettings = {
  /** False when Ataraxia cannot change model or effort for this provider. */
  configurable: boolean;
  /** Fallback presets, used until the live session reports its own. */
  models: ModelChoice[];
  /** Lowest to highest; empty when the provider has no effort knob. */
  efforts: string[];
  custom_model: boolean;
  /** Models and efforts come from the live session instead of this list. */
  dynamic: boolean;
  /** The chat can run as a named agent. */
  agents: boolean;
  /** Messages can be sent to a subagent from its own conversation. */
  subagent_messages: boolean;
};

export type ProviderDescriptor = {
  kind: ProviderKind;
  display_name: string;
  available: boolean;
  detail: string | null;
  settings: ProviderSettings;
};

export function agentListProviders() {
  return invoke<ProviderDescriptor[]>("agent_list_providers");
}

export function agentStartSession(sessionId: SessionId) {
  return invoke<void>("agent_start_session", { sessionId });
}

export function agentConfigureSession(
  sessionId: SessionId,
  model: string | null,
  effort: string | null,
  agent: string | null,
) {
  return invoke<ChatSession>("agent_configure_session", { sessionId, model, effort, agent });
}

export function agentSwitchProvider(sessionId: SessionId, provider: ProviderKind) {
  return invoke<ChatSession>("agent_switch_provider", { sessionId, provider });
}

export function agentMessageSubagent(sessionId: SessionId, subagentId: string, text: string) {
  return invoke<void>("agent_message_subagent", { sessionId, subagentId, text });
}

export function agentGetOptions(sessionId: SessionId) {
  return invoke<SessionOptions>("agent_get_options", { sessionId });
}

export function agentPrompt(sessionId: SessionId, text: string) {
  return invoke<string>("agent_prompt", { sessionId, text });
}

export function agentCancel(sessionId: SessionId) {
  return invoke<void>("agent_cancel", { sessionId, turnId: null });
}

export function agentResolvePermission(
  sessionId: SessionId,
  requestId: string,
  allow: boolean,
) {
  return invoke<void>("agent_resolve_permission", {
    sessionId,
    requestId,
    allow,
  });
}

export function agentGetSnapshot(sessionId: SessionId) {
  return invoke<ChatSnapshot>("agent_get_snapshot", { sessionId });
}

export function listenAgentEvents(
  handler: (event: AgentEvent) => void,
): Promise<UnlistenFn> {
  return listen<AgentEvent>("agent://event", (event) => {
    handler(event.payload);
  });
}

export type ChatState = {
  items: ChatItem[];
  subagents: SubagentView[];
  restoredCount: number;
  status: SessionStatus;
  pending: PendingPermission | null;
  error: string | null;
  loaded: boolean;
};

export const initialChatState: ChatState = {
  items: [],
  subagents: [],
  restoredCount: 0,
  status: "idle",
  pending: null,
  error: null,
  loaded: false,
};

export type ChatAction =
  | { type: "loaded"; snapshot: ChatSnapshot }
  | { type: "event"; event: AgentEvent }
  | { type: "failed"; message: string }
  | { type: "dismissError" };

function appendDelta(
  items: ChatItem[],
  role: ChatRole,
  turnId: string,
  text: string,
): ChatItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "message" && last.role === role && last.turnId === turnId) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [
    ...items,
    { kind: "message", id: `${turnId}:${items.length}`, role, text, turnId },
  ];
}

function settleTools(items: ChatItem[], turnId: string, ok: boolean): ChatItem[] {
  return items.map((item) =>
    item.kind === "tool" && item.turnId === turnId && item.status === "running"
      ? { ...item, status: ok ? "done" : "failed" }
      : item,
  );
}

function settleItems(items: ChatItem[], ok: boolean): ChatItem[] {
  return items.map((item) =>
    item.kind === "tool" && item.status === "running"
      ? { ...item, status: ok ? "done" : "failed" }
      : item,
  );
}

/** Applies one subagent update, creating the subagent on first sight (mirrors the host). */
export function applySubagent(
  subagents: SubagentView[],
  id: string,
  title: string,
  update: SubagentUpdate,
): SubagentView[] {
  const known = subagents.some((item) => item.id === id);
  const base = known
    ? subagents
    : [...subagents, { id, title, status: "running" as const, items: [] }];
  return base.map((item) => {
    if (item.id !== id) {
      return item;
    }
    const next: SubagentView = {
      ...item,
      title: title && title !== item.title ? title : item.title,
    };
    switch (update.kind) {
      case "started":
        return { ...next, status: "running" };
      case "detached":
        return { ...next, status: "running", detached: true };
      case "user":
        return {
          ...next,
          status: "running",
          items: [
            ...next.items,
            {
              kind: "message",
              id: `${id}:${next.items.length}`,
              role: "user",
              text: update.text,
              turnId: null,
            },
          ],
        };
      case "delta": {
        const last = next.items[next.items.length - 1];
        if (last && last.kind === "message" && last.role === "assistant") {
          return {
            ...next,
            items: [...next.items.slice(0, -1), { ...last, text: last.text + update.text }],
          };
        }
        return {
          ...next,
          items: [
            ...next.items,
            {
              kind: "message",
              id: `${id}:${next.items.length}`,
              role: "assistant",
              text: update.text,
              turnId: null,
            },
          ],
        };
      }
      case "tool":
        return {
          ...next,
          items: [
            ...next.items,
            {
              kind: "tool",
              callId: update.callId,
              turnId: id,
              name: update.name,
              input: update.input,
              output: null,
              status: "running",
            },
          ],
        };
      case "toolResult":
        return {
          ...next,
          items: next.items.map((entry) =>
            entry.kind === "tool" && entry.callId === update.callId
              ? { ...entry, output: update.output, status: update.ok ? "done" : "failed" }
              : entry,
          ),
        };
      case "done":
        return {
          ...next,
          detached: false,
          status: update.ok ? "done" : "failed",
          items: settleItems(next.items, update.ok),
        };
    }
  });
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "loaded":
      return {
        items: action.snapshot.items,
        subagents: action.snapshot.subagents ?? [],
        restoredCount: action.snapshot.restoredCount,
        status: action.snapshot.status,
        pending: action.snapshot.pendingPermission,
        error: null,
        loaded: true,
      };
    case "failed":
      return { ...state, error: action.message, loaded: true };
    case "dismissError":
      return { ...state, error: null };
    case "event": {
      const event = action.event;
      switch (event.type) {
        case "status":
          return { ...state, status: event.status };
        case "delta":
          return {
            ...state,
            items: appendDelta(state.items, event.role, event.turnId, event.text),
          };
        case "tool":
          return {
            ...state,
            items: [
              ...state.items,
              {
                kind: "tool",
                callId: event.callId,
                turnId: event.turnId,
                name: event.name,
                input: event.input,
                output: null,
                status: "running",
              },
            ],
          };
        case "toolUpdate":
          return {
            ...state,
            items: state.items.map((item) =>
              item.kind === "tool" && item.callId === event.callId
                ? {
                    ...item,
                    name: event.name ?? item.name,
                    input: event.input ?? item.input,
                  }
                : item,
            ),
          };
        case "toolResult":
          return {
            ...state,
            items: state.items.map((item) =>
              item.kind === "tool" && item.callId === event.callId
                ? {
                    ...item,
                    output: event.output,
                    status: event.ok ? "done" : "failed",
                  }
                : item,
            ),
          };
        case "permission":
          return {
            ...state,
            pending: {
              requestId: event.requestId,
              turnId: event.turnId,
              toolName: event.toolName,
              detail: event.detail,
            },
          };
        case "turnDone":
          return {
            ...state,
            pending: null,
            items: settleTools(state.items, event.turnId, event.ok),
            // A subagent still open when the turn ends can never report again, unless it runs
            // in the background and is meant to outlive the turn.
            subagents: state.subagents.map((item) =>
              item.status === "running" && !item.detached
                ? {
                    ...item,
                    status: event.ok ? "done" : "failed",
                    items: settleItems(item.items, event.ok),
                  }
                : item,
            ),
          };
        case "subagent":
          return {
            ...state,
            subagents: applySubagent(
              state.subagents,
              event.subagentId,
              event.title,
              event.update,
            ),
          };
        case "error":
          return { ...state, error: event.message, pending: null };
      }
    }
  }
}
