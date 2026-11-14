import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProviderUsage } from "./usage";
import type { ChatSession, ProviderKind, SessionId, SessionStatus } from "./workspace";

export type ChatRole = "user" | "assistant" | "system";
export type ToolStatus = "running" | "done" | "failed";

/** A picture attached to a message. The file stays in the app; `agentAttachment` reads it. */
export type ImageAttachment = { id: string; name: string; mime: string };

/** A picture on its way to the app: the file's bytes, base64. */
export type ImageUpload = { name: string; mime: string; data: string };

export type ChatMessage = {
  kind: "message";
  id: string;
  role: ChatRole;
  text: string;
  turnId: string | null;
  /** On the user's own messages. */
  images?: ImageAttachment[];
  /**
   * Shown as soon as the user sent it, before the app has taken it in. The app's own report of
   * the message takes its place (see `reconcile`), or it is withdrawn if the send failed.
   */
  pending?: boolean;
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

type AgentEventBody =
  | { type: "status"; sessionId: SessionId; status: SessionStatus }
  /** A provider reported its limits. Not about one chat. */
  | { type: "usage"; usage: ProviderUsage }
  | {
      type: "delta";
      sessionId: SessionId;
      turnId: string;
      role: ChatRole;
      text: string;
      images?: ImageAttachment[];
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

/**
 * What the app sends about an agent. `seq` is its place in the order the app sent them, which
 * lets the chat ignore one that reaches it twice; it is absent on events made without the app
 * (tests, the demo).
 */
export type AgentEvent = AgentEventBody & { seq?: number };

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

export function agentPrompt(sessionId: SessionId, text: string, images: ImageUpload[] = []) {
  return invoke<string>("agent_prompt", { sessionId, text, images });
}

/** An attached picture as a `data:` URL, to show it. */
export function agentAttachment(sessionId: SessionId, id: string) {
  return invoke<string>("agent_attachment", { sessionId, id });
}

/** A message typed while the agent was busy, waiting its turn. */
export type QueuedMessage = {
  id: string;
  text: string;
  /** Names of the pictures that go with it. */
  images: string[];
  /** Shown as soon as it was sent, before the app has put it in the queue: it has no id of the app's yet. */
  pending?: boolean;
};

/** A message that was sent to the queue and is not in the app's list yet. */
export type QueuedLocally = QueuedMessage & { text: string; known: ReadonlySet<string> };

/**
 * The queue as the person should see it: the app's list, then what was sent and is on its way
 * there. A message the app has since listed is not shown twice: it is matched on its text, among
 * the entries the app's list did not have when it was sent.
 */
export function withLocal(queue: MessageQueue, local: QueuedLocally[]): MessageQueue {
  if (local.length === 0) {
    return queue;
  }
  const claimed = new Set<string>();
  const waiting = local.filter((message) => {
    const reflected = queue.items.find(
      (item) => !message.known.has(item.id) && !claimed.has(item.id) && item.text === message.text,
    );
    if (reflected) {
      claimed.add(reflected.id);
    }
    return !reflected;
  });
  return {
    ...queue,
    items: [...queue.items, ...waiting.map(({ id, text, images }) => ({ id, text, images, pending: true }))],
  };
}

/** What a chat has waiting. `paused`: the last turn was stopped or failed, so nothing goes out alone. */
export type MessageQueue = { items: QueuedMessage[]; paused: boolean };

export const EMPTY_QUEUE: MessageQueue = { items: [], paused: false };

export function agentQueue(sessionId: SessionId) {
  return invoke<MessageQueue>("agent_queue", { sessionId });
}

export function agentEnqueue(sessionId: SessionId, text: string, images: ImageUpload[] = []) {
  return invoke<MessageQueue>("agent_enqueue", { sessionId, text, images });
}

export function agentQueueRemove(sessionId: SessionId, id: string) {
  return invoke<MessageQueue>("agent_queue_remove", { sessionId, id });
}

/** Stops the running turn and sends this message next, ahead of the others. */
export function agentQueueSendNow(sessionId: SessionId, id: string) {
  return invoke<MessageQueue>("agent_queue_send_now", { sessionId, id });
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
  /** The number of the last event applied, so a repeat of it is not applied again. */
  lastSeq: number;
  items: ChatItem[];
  subagents: SubagentView[];
  restoredCount: number;
  status: SessionStatus;
  pending: PendingPermission | null;
  error: string | null;
  loaded: boolean;
};

export const initialChatState: ChatState = {
  lastSeq: 0,
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
  /** The user sent a message: show it, and the agent as working, without waiting for the app. */
  | { type: "optimistic"; id: string; text: string; images: ImageAttachment[] }
  /** That send failed: take the message back out and put the status back as it was. */
  | { type: "rollback"; id: string; status: SessionStatus }
  | { type: "event"; event: AgentEvent }
  | { type: "failed"; message: string }
  | { type: "dismissError" };

/** The message shown ahead of the app that is this text, if there is one. */
export function waitingFor(items: ChatItem[], text: string): ChatMessage | undefined {
  const wanted = text.trim();
  for (const item of items) {
    if (item.kind === "message" && item.pending === true && item.role === "user" && item.text.trim() === wanted) {
      return item;
    }
  }
  return undefined;
}

/**
 * The app has taken in the user's message: the one shown at once becomes the real one, in the
 * same place and with the same key (so nothing is drawn again), or null if none was waiting for
 * this text. It matches on the text, because a message that is not ours (a note from a BTW, say)
 * can arrive just as we sent one.
 */
export function reconcile(
  items: ChatItem[],
  text: string,
  turnId: string,
  images?: ImageAttachment[],
): ChatItem[] | null {
  const shown = waitingFor(items, text);
  if (!shown) {
    return null;
  }
  const real: ChatMessage = {
    ...shown,
    text,
    turnId,
    pending: false,
    ...(images && images.length > 0 ? { images } : {}),
  };
  return items.map((item) => (item === shown ? real : item));
}

function appendDelta(
  items: ChatItem[],
  role: ChatRole,
  turnId: string,
  text: string,
  images?: ImageAttachment[],
): ChatItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "message" && last.role === role && last.turnId === turnId) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [
    ...items,
    {
      kind: "message",
      id: `${turnId}:${items.length}`,
      role,
      text,
      turnId,
      ...(images && images.length > 0 ? { images } : {}),
    },
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
        lastSeq: state.lastSeq,
        items: action.snapshot.items,
        subagents: action.snapshot.subagents ?? [],
        restoredCount: action.snapshot.restoredCount,
        status: action.snapshot.status,
        pending: action.snapshot.pendingPermission,
        error: null,
        loaded: true,
      };
    case "optimistic": {
      const shown: ChatMessage = {
        kind: "message",
        id: action.id,
        role: "user",
        text: action.text,
        turnId: null,
        pending: true,
        ...(action.images.length > 0 ? { images: action.images } : {}),
      };
      return { ...state, error: null, status: "working", items: [...state.items, shown] };
    }
    case "rollback":
      // Only a message still waiting is withdrawn: one the app has taken in is real, whatever
      // reports the failure.
      return {
        ...state,
        status: action.status,
        items: state.items.filter((item) => !(item.kind === "message" && item.id === action.id && item.pending === true)),
      };
    case "failed":
      return { ...state, error: action.message, loaded: true };
    case "dismissError":
      return { ...state, error: null };
    case "event": {
      const event = action.event;
      if (event.seq !== undefined) {
        // An event this chat has already applied, delivered again: nothing to do.
        if (event.seq <= state.lastSeq) {
          return state;
        }
        state = { ...state, lastSeq: event.seq };
      }
      switch (event.type) {
        case "status":
          return { ...state, status: event.status };
        case "delta": {
          const taken = event.role === "user" ? reconcile(state.items, event.text, event.turnId, event.images) : null;
          return {
            ...state,
            items: taken ?? appendDelta(state.items, event.role, event.turnId, event.text, event.images),
          };
        }
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
        case "usage":
          // About the provider, not this chat: the meter listens for it itself.
          return state;
      }
    }
  }
}
