// Browser-only stand-in for the Tauri IPC so the UI can be reviewed with `pnpm dev`.
// Never loaded inside the real app (main.tsx checks for __TAURI_INTERNALS__).
import { handleInsights, removeFile } from "./insightsMock";

export {};

const now = new Date().toISOString();
const repo = { id: "r1", root: "/Users/dev/archipelago-backend", name: "archipelago-backend", created_at: now, updated_at: now };
const worktrees = [
  // `?branch=` previews a long branch name; `?branch=none` a worktree with no branch.
  { id: "w1", repository_id: "r1", path: "/Users/dev/archipelago-backend", branch: (() => { const given = new URLSearchParams(window.location.search).get("branch"); return given === "none" ? null : (given ?? "feature/course-mask"); })(), head: "d76d97b4", created_at: now, updated_at: now },
  { id: "w2", repository_id: "r1", path: "/Users/dev/archipelago-backend", branch: "main", head: "a1b2c3d4", created_at: now, updated_at: now },
  { id: "w3", repository_id: "r2", path: "/Users/dev/ataraxia-ui", branch: "main", head: "9f8e7d6c", created_at: now, updated_at: now },
];
const session = { id: "s1", repository_id: "r1", worktree_id: "w1", provider: "codex", title: "Refactor document generation", status: "ready", model: null as string | null, effort: null as string | null, agent: null as string | null, created_at: now, updated_at: now, last_opened_at: now };

const sessions = [
  session,
  { ...session, id: "s2", worktree_id: "w1", provider: "claude", title: "Add retry to the dispatcher" },
  { ...session, id: "s3", worktree_id: "w2", provider: "opencode", title: "Explain the worker lifecycle" },
];

// `?state=empty|permission|working|fresh` previews other UI states in the browser.
const mode = new URLSearchParams(window.location.search).get("state");

// `?workspace=multi` opens a workspace of two repositories; by default each repository is its own.
const multi = new URLSearchParams(window.location.search).get("workspace") === "multi";
const workspaces = [
  { id: "ws1", name: "archipelago-backend", repository_ids: ["r1"], created_at: now, updated_at: now },
  { id: "ws2", name: "ataraxia-ui", repository_ids: ["r2"], created_at: now, updated_at: now },
  ...(multi ? [{ id: "ws3", name: "acme", repository_ids: ["r1", "r2"], created_at: now, updated_at: now }] : []),
];
const snapshot: { selected_worktree_id: string | null; [key: string]: unknown; sessions: typeof sessions; repositories: Array<typeof repo>; selected_workspace_id: string | null; selected_repository_id: string | null; workspaces: typeof workspaces; worktrees: typeof worktrees; selected_session_id: string | null } = {
  repositories: [repo, { ...repo, id: "r2", root: "/Users/dev/ataraxia-ui", name: "ataraxia-ui" }],
  workspaces,
  selected_workspace_id: multi ? "ws3" : "ws1",
  selected_repository_id: "r1",
  worktrees,
  selected_worktree_id: "w1",
  sessions,
  selected_session_id: mode === "empty" ? null : "s1",
};
if (mode === "empty") {
  snapshot.sessions = [];
}

// Every answer is a fresh copy, as it is over IPC: React must see a new object to redraw.
const view = () => JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;

const chat: { items: unknown[]; subagents: unknown[]; restoredCount: number; status: string; pendingPermission: unknown } = {
  subagents: [],
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
// `?state=subagents` shows the subagent switcher with a finished and a running subagent.
if (mode === "subagents") {
  const t = "t1";
  chat.subagents = [
    { id: "sa1", title: "Explore the repo", status: "done", items: [
      { kind: "tool", callId: "sc1", turnId: t, name: "Grep", input: JSON.stringify({ pattern: "fn main" }), output: "src/main.rs", status: "done" },
      { kind: "message", id: "sm1", role: "assistant", text: "Found **one** entry point in `src/main.rs`.", turnId: null },
    ] },
    { id: "sa2", title: "Review the diff", status: "running", items: [
      { kind: "tool", callId: "sc2", turnId: t, name: "Bash", input: JSON.stringify({ command: "git diff" }), output: null, status: "running" },
    ] },
  ];
}

const m = (id: string, label: string, efforts: string[] = []) => ({ id, label, efforts });
const providers = [
  { kind: "fake", display_name: "Fake", available: true, detail: null, settings: { configurable: true, models: [m("fake-fast", "Fake fast")], efforts: ["low", "medium", "high"], custom_model: false, dynamic: false, agents: true, subagent_messages: true } },
  { kind: "claude", display_name: "Claude Code", available: true, detail: null, settings: { configurable: true, models: [m("sonnet", "Sonnet"), m("opus", "Opus"), m("haiku", "Haiku"), m("fable", "Fable")], efforts: ["low", "medium", "high", "xhigh", "max"], custom_model: true, dynamic: false, agents: true, subagent_messages: true } },
  { kind: "codex", display_name: "Codex", available: true, detail: null, settings: { configurable: true, models: [], efforts: ["low", "medium", "high", "xhigh"], custom_model: true, dynamic: true, agents: true, subagent_messages: true } },
  { kind: "opencode", display_name: "OpenCode", available: true, detail: null, settings: { configurable: true, models: [], efforts: [], custom_model: false, dynamic: true, agents: true, subagent_messages: true } },
];

// What each live session would report; Codex and OpenCode discover theirs from the provider.
const optionsByProvider: Record<string, unknown> = {
  fake: { models: [], default_model: null, efforts: [], agents: [{ id: "reviewer", label: "reviewer", description: "Reviews the change" }] },
  claude: { models: [m("sonnet", "Sonnet"), m("opus", "Opus"), m("haiku", "Haiku"), m("fable", "Fable")], default_model: null, efforts: ["low", "medium", "high", "xhigh", "max"], agents: [{ id: "code-reviewer", label: "code-reviewer", description: "Reviews diffs for bugs" }, { id: "explorer", label: "explorer", description: null }] },
  codex: { models: [m("gpt-6.1-sol", "GPT 6.1 Sol", ["low", "medium", "high", "xhigh"]), m("gpt-6.1-mini", "GPT 6.1 Mini", ["low", "medium"])], default_model: "gpt-6.1-sol", efforts: ["low", "medium", "high", "xhigh"], agents: [{ id: "pr_explorer", label: "pr_explorer", description: "Maps the affected code paths" }] },
  opencode: { models: ["Daybreak Blue", "Daybreak Red", "GPT-4.1", "GPT-4.1 Fast", "GPT-4.1 mini", "GPT-4.1 mini Fast", "GPT-4o", "GPT-4o (2024-08-06)", "GPT-4o (2024-11-20)", "GPT-4o Fast", "GPT-5", "GPT-5 mini", "o3", "o4-mini"].map((n) => m("openai/" + n, "openai/" + n)).concat([m("anthropic/claude-sonnet-5-5", "anthropic/Claude Sonnet 5.5")]), default_model: "anthropic/claude-sonnet-5-5", efforts: ["low", "high"], agents: [{ id: "build", label: "build", description: "Full access" }, { id: "plan", label: "plan", description: "Read-only planning" }] },
};

const callbacks = new Map<number, (event: unknown) => void>();
const listeners: Record<string, number[]> = {};
function emit(event: string, payload: unknown) {
  for (const handler of listeners[event] ?? []) {
    callbacks.get(handler)?.({ event, id: handler, payload });
  }
}

function handle(cmd: string, args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case "core_status": return "ready";
    case "agent_list_providers": return providers;
    case "agent_get_snapshot": return chat;
    case "agent_get_options": {
      const target = snapshot.sessions.find((item) => item.id === args?.sessionId) ?? session;
      return optionsByProvider[target.provider];
    }
    case "agent_switch_provider": {
      const target = snapshot.sessions.find((item) => item.id === args?.sessionId) ?? session;
      target.provider = args?.provider as string;
      target.model = null;
      target.effort = null;
      target.agent = null;
      chat.restoredCount = chat.items.length;
      return target;
    }
    case "agent_configure_session": {
      const target = snapshot.sessions.find((item) => item.id === args?.sessionId) ?? session;
      target.model = (args?.model as string | null) ?? null;
      target.effort = (args?.effort as string | null) ?? null;
      target.agent = (args?.agent as string | null) ?? null;
      return target;
    }
    case "workspace_list_branches": {
      const current = worktrees.find((item) => item.id === args?.worktreeId)?.branch ?? "main";
      const names = ["main", "feature/course-mask", "fix/prohibited-question-feedback", "fix/node-24-cve-2025-55130", "feature/diff-target", "feature/spec-v1.1-remaining", "chore/bump-deps", "release/2.3", "hotfix/token-expiry", "dirty/conflicts-with-your-edits"];
      return { branches: names.map((name) => ({ name, current: name === current, worktree_id: worktrees.find((item) => item.branch === name && name !== current)?.id ?? null })), workspace: { ...snapshot, worktrees: worktrees.map((item) => ({ ...item })) } };
    }
    case "workspace_select_branch": {
      const name = String(args?.name);
      if (name === "dirty/conflicts-with-your-edits") {
        throw new Error("could not switch to `dirty/conflicts-with-your-edits`: error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/studio/auth/tokens.py\nPlease commit your changes or stash them before you switch branches.");
      }
      const target = worktrees.find((item) => item.id === args?.worktreeId)!;
      const open = worktrees.find((item) => item.branch === name);
      if (open) {
        snapshot.selected_worktree_id = open.id;
      } else {
        target.branch = name;
      }
      return { ...snapshot, worktrees: worktrees.map((item) => ({ ...item })) };
    }
    case "workspace_select_repository": {
      const target = snapshot.repositories.find((item) => item.id === args?.repositoryId);
      if (target) {
        snapshot.selected_repository_id = target.id;
        snapshot.selected_worktree_id = worktrees.find((item) => item.repository_id === target.id)?.id ?? null;
      }
      return view();
    }
    case "workspace_select_workspace": {
      const target = workspaces.find((item) => item.id === args?.workspaceId);
      if (target) {
        snapshot.selected_workspace_id = target.id;
        snapshot.selected_repository_id = target.repository_ids[0];
        snapshot.selected_worktree_id = worktrees.find((item) => item.repository_id === target.repository_ids[0])?.id ?? null;
      }
      return view();
    }
    case "workspace_register_repository": {
      const path = String(args?.path);
      const name = path.split("/").filter(Boolean).pop() ?? path;
      const added = { ...repo, id: `r${snapshot.repositories.length + 1}`, root: path, name };
      snapshot.repositories.push(added);
      return added;
    }
    case "workspace_create_workspace": {
      const name = String(args?.name).trim();
      if (workspaces.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`a workspace named \`${name}\` already exists`);
      }
      const created = { id: `ws${workspaces.length + 1}`, name, repository_ids: args?.repositoryIds as string[], created_at: now, updated_at: now };
      workspaces.push(created);
      snapshot.selected_workspace_id = created.id;
      snapshot.selected_repository_id = created.repository_ids[0];
      return view();
    }
    case "workspace_update_workspace": {
      const target = workspaces.find((item) => item.id === args?.workspaceId)!;
      target.name = String(args?.name).trim();
      target.repository_ids = args?.repositoryIds as string[];
      if (!target.repository_ids.includes(snapshot.selected_repository_id!)) {
        snapshot.selected_repository_id = target.repository_ids[0];
      }
      return view();
    }
    case "workspace_delete_workspace": {
      const at = workspaces.findIndex((item) => item.id === args?.workspaceId);
      if (snapshot.sessions.length > 0 && snapshot.selected_workspace_id === args?.workspaceId) {
        throw new Error(`this workspace still has ${snapshot.sessions.length} chats: delete them first`);
      }
      workspaces.splice(at, 1);
      snapshot.selected_workspace_id = workspaces[0]?.id ?? null;
      return view();
    }
    case "code_repo_changes": return [
      { repositoryId: "r1", files: 2, unreviewed: 2 },
      { repositoryId: "r2", files: 3, unreviewed: 3 },
    ];
    case "workspace_bootstrap":
    case "workspace_select_worktree":
    case "workspace_create_session":
    case "workspace_open_session":
    case "workspace_open_repository": return view();
    case "plugin:event|listen": {
      const target = args as { event: string; handler: number } | undefined;
      if (target) {
        (listeners[target.event] ??= []).push(target.handler);
      }
      return 1;
    }
    case "terminal_ensure": return { sessionId: "p1", created: true };
    default: {
      const result = handleInsights(cmd, args, emit);
      return result.handled ? result.value : null;
    }
  }
}

let callbackId = 0;
const w = window as unknown as Record<string, unknown>;
w.__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise.resolve(handle(cmd, args)),
  transformCallback: (callback: (event: unknown) => void) => {
    callbacks.set(++callbackId, callback);
    return callbackId;
  },
  unregisterCallback: () => undefined,
  convertFileSrc: (p: string) => p,
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
// What a terminal does to the preview: `__ataraxiaMock.removeFile("README.md")` is a `git rm`.
w.__ataraxiaMock = {
  removeFile: (path: string) => {
    removeFile(path);
    emit("worktree://files-changed", { worktreeId: "w1" });
  },
};
