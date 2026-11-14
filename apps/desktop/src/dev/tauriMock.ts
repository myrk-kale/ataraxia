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
    { kind: "message", id: "m4", role: "assistant", text: "How the pieces fit:\n\n| Part | Role | Status |\n| --- | --- | --- |\n| API | accepts the request | done |\n| Worker | persists progress | done |\n| Poller | reads the status | todo |\n\n```mermaid\nflowchart LR\n  A[Client] -->|POST /documents| B(API)\n  B --> C{Queue}\n  C --> D[Worker]\n  D --> E[(Database)]\n```\n\nAnd one that is not a diagram:\n\n```mermaid\nthis is not mermaid\n```", turnId: "t1" },
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
// `?state=diagrams` is one reply with a diagram of each kind: flowcharts that are drawn as text,
// and others that go to the Mermaid library.
if (mode === "diagrams") {
  const fence = (body: string) => "```mermaid\n" + body + "\n```";
  chat.items = [
    { kind: "message", id: "d0", role: "user", text: "Draw the architecture.", turnId: "t0" },
    {
      kind: "message",
      id: "d1",
      role: "assistant",
      turnId: "t0",
      text: [
        "A pipeline:",
        fence("flowchart LR\n  C[Client] --> G[API Gateway]\n  G --> Q[Queue]\n  Q --> W[Worker]\n  W --> D[(Database)]"),
        "A decision with labelled links, top down:",
        fence("flowchart TD\n  S([Start]) --> Q{Valid?}\n  Q -->|yes| P[Process]\n  Q -->|no| E[Reject]\n  P --> F([Done])\n  E --> F"),
        "A fan-out with a link that skips a stage, and a retry that loops back:",
        fence("flowchart LR\n  I[Incoming] --> V[Validate]\n  V --> R[Router]\n  R --> A[Service A]\n  R --> B[Service B]\n  A --> D[Storage]\n  B --> D\n  I --> D\n  D -.-> R"),
        "A sequence diagram, which is not a flowchart:",
        fence("sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi"),
        "A flowchart with a subgraph, which the text drawing leaves to the library:",
        fence("flowchart LR\n  subgraph one\n    A --> B\n  end\n  B --> C"),
      ].join("\n\n"),
    },
  ];
}
// `?state=dgascii` and `?state=dgsvg` hold the same five-node chain; the second ends in a link the
// text drawing does not draw, so the Mermaid library draws it. For comparing the two.
if (mode === "dgascii" || mode === "dgsvg") {
  const last = mode === "dgsvg" ? "W <--> D[(Database)]" : "W --> D[(Database)]";
  chat.items = [
    { kind: "message", id: "c0", role: "assistant", turnId: "t0", text: "```mermaid\nflowchart LR\n  C[Client] --> G[API Gateway]\n  G --> Q[Queue]\n  Q --> W[Worker]\n  " + last + "\n```" },
  ];
}
// `?state=long` is a chat that has been going for a long time: 400 turns, each with a question,
// some tool calls and a reply, now and then with a table or a diagram.
if (mode === "long") {
  const paragraph = "This part of the work changes how the request is validated before it reaches the worker, and keeps the old behaviour for callers that still send the previous shape. ";
  chat.items = Array.from({ length: 400 }, (_, n) => {
    const turnId = `lt${n}`;
    const table = n % 7 === 3 ? "\n\n| Part | Role | Status |\n| --- | --- | --- |\n| API | accepts the request | done |\n| Worker | persists progress | todo |" : "";
    const diagram = n % 50 === 10 ? "\n\n```mermaid\nflowchart LR\n  A[Client] --> B(API)\n  B --> C[Worker]\n```" : "";
    const code = n % 5 === 0 ? "\n\n```ts\nexport function step" + n + "(input: string) {\n  return input.trim();\n}\n```" : "";
    return [
      { kind: "message", id: `lu${n}`, role: "user", text: `Question ${n}: how should step ${n} behave when the input is empty?`, turnId: null },
      { kind: "message", id: `la${n}`, role: "assistant", text: `Answer ${n}. ` + paragraph.repeat(1 + (n % 4)) + table + code + diagram, turnId },
      { kind: "tool", callId: `lc${n}a`, turnId, name: "Bash", input: JSON.stringify({ command: `pytest tests/step_${n} -q` }), output: `${n % 9} passed in 1.${n % 10}s\n`.repeat(20), status: "done" },
      { kind: "tool", callId: `lc${n}b`, turnId, name: "Edit", input: JSON.stringify({ file_path: `src/step_${n}.py`, old_string: "return a", new_string: "return b" }), output: "ok", status: "done" },
      { kind: "message", id: `lf${n}`, role: "assistant", text: `Done with step ${n}.`, turnId },
    ];
  }).flat();
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
// A pretend agent for previewing the message queue: a turn lasts a few seconds (`?turn=ms`).
const TURN_MS = Number(new URLSearchParams(window.location.search).get("turn") ?? 3000);
const turns = new Map<string, ReturnType<typeof setTimeout>>();
const queues = new Map<string, { items: { id: string; text: string; images: { name: string; mime: string; data: string }[] }[]; paused: boolean }>();
const pictures = new Map<string, string>();
const forced = new Set<string>();
let queueCounter = 0;
let pictureCounter = 0;
let turnCounter = 0;

function stateOf(sessionId: string) {
  let queue = queues.get(sessionId);
  if (!queue) {
    queue = { items: [], paused: false };
    queues.set(sessionId, queue);
  }
  return queue;
}

function queueOf(sessionId: string) {
  const { items, paused } = stateOf(sessionId);
  return { items: items.map((item) => ({ id: item.id, text: item.text, images: item.images.map((image) => image.name) })), paused };
}

function announceQueue(sessionId: string) {
  emit("insight://event", { type: "queue", sessionId, queue: queueOf(sessionId) });
}

type Upload = { name: string; mime: string; data: string };

function startTurn(sessionId: string, text: string, uploads: Upload[] = []) {
  const turnId = `t${Date.now()}-${++turnCounter}`;
  const images = uploads.map((upload) => {
    const id = `img${++pictureCounter}`;
    pictures.set(`${sessionId}:${id}`, `data:${upload.mime};base64,${upload.data}`);
    return { id, name: upload.name, mime: upload.mime };
  });
  emit("agent://event", { type: "delta", sessionId, turnId, role: "user", text, ...(images.length > 0 ? { images } : {}) });
  emit("agent://event", { type: "status", sessionId, status: "working" });
  turns.set(sessionId, setTimeout(() => finishTurn(sessionId, true), TURN_MS));
  return turnId;
}

function finishTurn(sessionId: string, ok: boolean) {
  clearTimeout(turns.get(sessionId));
  turns.delete(sessionId);
  emit("agent://event", { type: "turnDone", sessionId, turnId: "t", ok });
  emit("agent://event", { type: "status", sessionId, status: "ready" });
  advanceQueue(sessionId, ok);
}

function advanceQueue(sessionId: string, ok: boolean) {
  const queue = queues.get(sessionId);
  if (!queue || queue.items.length === 0) {
    return;
  }
  if (!ok && !forced.has(sessionId)) {
    queue.paused = true;
    announceQueue(sessionId);
    return;
  }
  forced.delete(sessionId);
  queue.paused = false;
  const [next, ...rest] = queue.items;
  queue.items = rest;
  announceQueue(sessionId);
  startTurn(sessionId, next!.text, next!.images);
}

// What the providers last said about their limits. Claude and Codex report them; OpenCode and
// the demo provider say nothing, so they show no meter.
const nowSeconds = () => Math.floor(Date.now() / 1000);
const usageReports: Record<string, unknown> = {
  claude: {
    provider: "claude",
    profile: null,
    plan: null,
    updatedAt: nowSeconds() - 120,
    windows: [
      { kind: "five_hour", usedPercent: 6, resetsAt: nowSeconds() + 3 * 3600 + 12 * 60 },
      { kind: "weekly", usedPercent: 76, resetsAt: nowSeconds() + 2 * 86400 + 4 * 3600 },
    ],
  },
  codex: {
    provider: "codex",
    profile: null,
    plan: "pro",
    updatedAt: nowSeconds() - 600,
    windows: [
      { kind: "five_hour", usedPercent: 12, resetsAt: nowSeconds() + 4 * 3600 },
      { kind: "weekly", usedPercent: 64, resetsAt: nowSeconds() + 5 * 86400 },
    ],
  },
};

let profileCounter = 0;
let profileBook: { profiles: { id: string; provider: string; name: string; color: string; command: string }[]; active: Record<string, string> } =
  mode === "profiles"
    ? {
        profiles: [
          { id: "pw", provider: "claude", name: "Work", color: "#3b82f6", command: "CLAUDE_CONFIG_DIR=~/.claude-work claude" },
          { id: "pp", provider: "claude", name: "Personal", color: "#ec4899", command: "CLAUDE_CONFIG_DIR=~/.claude-personal" },
        ],
        active: { claude: "pw" },
      }
    : { profiles: [], active: {} };

// Like the app, each agent event goes out with its number. `?dup=1` delivers every event twice,
// as a listener left over from a hot reload would; `?noseq=1` leaves the numbers off, as before.
let agentSeq = 0;
function emit(event: string, payload: unknown) {
  const query = new URLSearchParams(window.location.search);
  const body =
    event === "agent://event" && !query.has("noseq") ? { ...(payload as object), seq: (agentSeq += 1) } : payload;
  const times = query.has("dup") ? 2 : 1;
  for (let round = 0; round < times; round += 1) {
    for (const handler of listeners[event] ?? []) {
      callbacks.get(handler)?.({ event, id: handler, payload: body });
    }
  }
}

function handle(cmd: string, args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case "core_status": return "ready";
    case "agent_list_providers": return providers;
    case "agent_usage": return Object.values(usageReports);
    // Launch profiles: what the settings keep, with the checks the app would make.
    case "profiles_list": return profileBook;
    case "profile_save": {
      const profile = args?.profile as { id: string; provider: string; name: string; color: string; command: string };
      const name = profile.name.trim();
      if (!name) throw "a profile needs a name";
      if (!/^#[0-9a-fA-F]{6}$/.test(profile.color.trim())) throw "the colour is written as #rrggbb";
      if (!profile.command.trim()) throw "a profile needs a command";
      if (profileBook.profiles.some((other) => other.provider === profile.provider && other.id !== profile.id && other.name.toLowerCase() === name.toLowerCase())) throw `there is already a profile called ${name}`;
      const kept = { ...profile, name, id: profile.id || `p${++profileCounter}` };
      const at = profileBook.profiles.findIndex((other) => other.id === kept.id);
      profileBook = { ...profileBook, profiles: at >= 0 ? profileBook.profiles.map((other, i) => (i === at ? kept : other)) : [...profileBook.profiles, kept] };
      return profileBook;
    }
    case "profile_delete": {
      const id = args?.id as string;
      profileBook = { profiles: profileBook.profiles.filter((p) => p.id !== id), active: Object.fromEntries(Object.entries(profileBook.active).filter(([, v]) => v !== id)) };
      return profileBook;
    }
    case "profile_set_active": {
      const provider = args?.provider as string; const id = args?.id as string | null;
      const active = { ...profileBook.active };
      if (id) active[provider] = id; else delete active[provider];
      profileBook = { ...profileBook, active };
      return profileBook;
    }
    case "profile_check": {
      const command = String(args?.command ?? "").trim();
      const words = command.split(/\s+/).filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
      const settings = command.split(/\s+/).filter((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)).length;
      const withSettings = settings === 0 ? "" : settings === 1 ? " with 1 setting" : ` with ${settings} settings`;
      if (!command) return { ok: false, message: "a profile needs a command" };
      if (words.length === 0) return { ok: true, message: `Starts the usual program${withSettings}.` };
      if (/nowhere|missing/.test(words[0])) return { ok: false, message: `${words[0]} was not found.` };
      return { ok: true, message: `Runs /usr/local/bin/${words[0].split("/").pop()}${withSettings}.` };
    }
    // Test hook: the agent streams text into its current message.
    case "dev_agent_delta":
      emit("agent://event", { type: "delta", sessionId: args?.sessionId, turnId: args?.turnId ?? "ts", role: "assistant", text: args?.text ?? "" });
      return null;
    // Test hook: a provider reports new limits (`windows` replaces the old ones).
    case "dev_agent_usage": {
      const provider = String(args?.provider);
      const profile = (args?.profile as string | undefined) ?? null;
      const slot = profile ? `${provider}:${profile}` : provider;
      const report = { provider, profile, plan: null, ...(usageReports[slot] as object), ...(args?.report as object), updatedAt: nowSeconds() };
      usageReports[slot] = report;
      emit("agent://event", { type: "usage", usage: report });
      return null;
    }
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
    case "workspace_delete_session": {
      const index = snapshot.sessions.findIndex((item) => item.id === args?.sessionId);
      if (index >= 0) {
        snapshot.sessions.splice(index, 1);
      }
      if (snapshot.selected_session_id === args?.sessionId) {
        snapshot.selected_session_id = null;
      }
      return view();
    }
    case "plugin:event|listen": {
      const target = args as { event: string; handler: number } | undefined;
      if (target) {
        (listeners[target.event] ??= []).push(target.handler);
      }
      return target?.handler ?? 1;
    }
    case "plugin:event|unlisten": {
      const target = args as { event: string; eventId: number } | undefined;
      if (target && listeners[target.event]) {
        listeners[target.event] = listeners[target.event]!.filter((handler) => handler !== target.eventId);
      }
      return null;
    }
    case "agent_prompt": {
      // A prompt starts the conversation: the user's message appears, as the real host reports it.
      const sessionId = (args?.sessionId as string) ?? "s1";
      const text = String(args?.text ?? "");
      // `?latency=700` makes the app slow to take a message in, as it is when it has to look at
      // git first; a message holding FAIL is refused after that time.
      const wait = Number(new URLSearchParams(window.location.search).get("latency") ?? 0);
      if (wait <= 0 && !text.includes("FAIL")) {
        return startTurn(sessionId, text, (args?.images as Upload[] | undefined) ?? []);
      }
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          if (text.includes("FAIL")) {
            reject(new Error("the agent refused it"));
          } else {
            resolve(startTurn(sessionId, text, (args?.images as Upload[] | undefined) ?? []));
          }
        }, wait),
      );
    }
    case "agent_attachment": {
      const found = pictures.get(`${args?.sessionId}:${args?.id}`);
      if (!found) {
        throw new Error("image not found");
      }
      return found;
    }
    case "agent_cancel": {
      const sessionId = (args?.sessionId as string) ?? "s1";
      if (turns.has(sessionId)) {
        finishTurn(sessionId, false);
      }
      return null;
    }
    case "agent_queue": return queueOf((args?.sessionId as string) ?? "s1");
    case "agent_enqueue": {
      const sessionId = (args?.sessionId as string) ?? "s1";
      const queue = stateOf(sessionId);
      queue.items.push({ id: `q${++queueCounter}`, text: String(args?.text ?? "").trim(), images: (args?.images as Upload[] | undefined) ?? [] });
      announceQueue(sessionId);
      if (!turns.has(sessionId) && !queue.paused) {
        advanceQueue(sessionId, true);
      }
      return queueOf(sessionId);
    }
    case "agent_queue_remove": {
      const sessionId = (args?.sessionId as string) ?? "s1";
      const queue = stateOf(sessionId);
      queue.items = queue.items.filter((item) => item.id !== args?.id);
      announceQueue(sessionId);
      return queueOf(sessionId);
    }
    case "agent_queue_send_now": {
      const sessionId = (args?.sessionId as string) ?? "s1";
      const queue = stateOf(sessionId);
      const picked = queue.items.find((item) => item.id === args?.id);
      if (picked) {
        queue.items = [picked, ...queue.items.filter((item) => item !== picked)];
        queue.paused = false;
        forced.add(sessionId);
        announceQueue(sessionId);
        if (turns.has(sessionId)) {
          finishTurn(sessionId, false);
        } else {
          advanceQueue(sessionId, true);
        }
      }
      return queueOf(sessionId);
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
