// Browser-only stand-in for the Tauri IPC so the UI can be reviewed with `pnpm dev`.
// Never loaded inside the real app (main.tsx checks for __TAURI_INTERNALS__).
export {};

const now = new Date().toISOString();
const repo = { id: "r1", root: "/Users/dev/archipelago-backend", name: "archipelago-backend", created_at: now, updated_at: now };
const worktrees = [
  { id: "w1", repository_id: "r1", path: "/Users/dev/archipelago-backend", branch: "feature/course-mask", head: "d76d97b4", created_at: now, updated_at: now },
  { id: "w2", repository_id: "r1", path: "/Users/dev/archipelago-backend", branch: "main", head: "a1b2c3d4", created_at: now, updated_at: now },
];
const session = { id: "s1", repository_id: "r1", worktree_id: "w1", provider: "codex", title: "Refactor document generation", status: "ready", model: null as string | null, effort: null as string | null, created_at: now, updated_at: now, last_opened_at: now };

const sessions = [
  session,
  { ...session, id: "s2", worktree_id: "w1", provider: "claude", title: "Add retry to the dispatcher" },
  { ...session, id: "s3", worktree_id: "w2", provider: "opencode", title: "Explain the worker lifecycle" },
];

// `?state=empty|permission|working|fresh` previews other UI states in the browser.
const mode = new URLSearchParams(window.location.search).get("state");

const snapshot = {
  repositories: [repo, { ...repo, id: "r2", name: "concierge-ui" }],
  selected_repository_id: "r1",
  worktrees,
  selected_worktree_id: "w1",
  sessions,
  selected_session_id: mode === "empty" ? null : "s1",
};
if (mode === "empty") {
  snapshot.sessions = [];
}

const chat = {
  items: [
    { kind: "message", id: "m1", role: "user", text: "Implement asynchronous document generation. Keep the API consistent and add regression tests.", turnId: "t1" },
    { kind: "message", id: "m2", role: "assistant", text: "I'll make generation asynchronous.\n\n- `POST /documents` now returns **202 Accepted**\n- a worker persists progress\n\n```python\nasync def dispatch(job_id: int) -> None:\n    await worker.enqueue(job_id)\n```", turnId: "t1" },
    { kind: "tool", callId: "c1", turnId: "t1", name: "Bash", input: JSON.stringify({ command: "pytest tests/documents -q" }), output: "18 passed in 2.41s", status: "done" },
    { kind: "tool", callId: "c2", turnId: "t1", name: "Edit", input: JSON.stringify({ file_path: "src/studio/documents/repositories.py", old_string: "return result.scalar()", new_string: "return result.scalar_one_or_none()" }), output: "ok", status: "done" },
    { kind: "message", id: "m3", role: "assistant", text: "Implemented asynchronous generation. The request now returns 202 Accepted and the worker persists progress. I updated the repository and added tests.", turnId: "t1" },
  ],
  restoredCount: mode === "restored" ? 2 : 0,
  status: mode === "permission" ? "waiting-permission" : mode === "working" ? "working" : "ready",
  pendingPermission:
    mode === "permission"
      ? { requestId: "p1", turnId: "t1", toolName: "Bash", detail: "Allow running pytest tests/documents -q in the selected worktree?" }
      : null,
};
if (mode === "fresh") {
  chat.items = [];
}

const noSettings = { configurable: false, models: [], efforts: [], custom_model: false };
const providers = [
  { kind: "fake", display_name: "Fake", available: true, detail: null, settings: { configurable: true, models: [{ id: "fake-fast", label: "Fake fast" }], efforts: ["low", "medium", "high"], custom_model: false } },
  { kind: "claude", display_name: "Claude Code", available: true, detail: null, settings: { configurable: true, models: [{ id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }, { id: "haiku", label: "Haiku" }, { id: "fable", label: "Fable" }], efforts: ["low", "medium", "high", "xhigh", "max"], custom_model: true } },
  { kind: "codex", display_name: "Codex", available: true, detail: null, settings: { configurable: true, models: [], efforts: ["low", "medium", "high", "xhigh"], custom_model: true } },
  { kind: "opencode", display_name: "OpenCode", available: false, detail: "not found", settings: noSettings },
];

function handle(cmd: string, args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case "core_status": return "ready";
    case "agent_list_providers": return providers;
    case "agent_get_snapshot": return chat;
    case "agent_configure_session": {
      const target = snapshot.sessions.find((item) => item.id === args?.sessionId) ?? session;
      target.model = (args?.model as string | null) ?? null;
      target.effort = (args?.effort as string | null) ?? null;
      return target;
    }
    case "workspace_bootstrap":
    case "workspace_select_repository":
    case "workspace_select_worktree":
    case "workspace_create_session":
    case "workspace_open_session":
    case "workspace_open_repository": return snapshot;
    case "plugin:event|listen": return 1;
    case "terminal_ensure": return { sessionId: "p1", created: true };
    default: return null;
  }
}

let callbackId = 0;
const w = window as unknown as Record<string, unknown>;
w.__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise.resolve(handle(cmd, args)),
  transformCallback: () => ++callbackId,
  unregisterCallback: () => undefined,
  convertFileSrc: (p: string) => p,
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
