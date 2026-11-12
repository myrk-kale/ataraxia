import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProviderKind, SessionId, SessionStatus } from "./workspace";

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

export type ChatSnapshot = {
  items: ChatItem[];
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
  | { type: "error"; sessionId: SessionId; message: string };

export type ProviderDescriptor = {
  kind: ProviderKind;
  display_name: string;
};

export function agentListProviders() {
  return invoke<ProviderDescriptor[]>("agent_list_providers");
}

export function agentStartSession(sessionId: SessionId) {
  return invoke<void>("agent_start_session", { sessionId });
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
  status: SessionStatus;
  pending: PendingPermission | null;
  error: string | null;
  loaded: boolean;
};

export const initialChatState: ChatState = {
  items: [],
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

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "loaded":
      return {
        items: action.snapshot.items,
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
          };
        case "error":
          return { ...state, error: event.message, pending: null };
      }
    }
  }
}
