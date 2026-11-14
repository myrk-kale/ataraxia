// Browser-only sample data for Code, Decisions, Flow, BTW and artifacts (see tauriMock.ts).
export {};

type Emit = (event: string, payload: unknown) => void;

const now = new Date().toISOString();
const sessionId = "s1";

const files = [
  { path: "src/studio/auth/tokens.py", old_path: null, change: "modified", additions: 31, deletions: 4, binary: false },
  { path: "src/studio/documents/service.py", old_path: null, change: "modified", additions: 62, deletions: 11, binary: false },
  { path: "src/studio/documents/repositories.py", old_path: null, change: "modified", additions: 8, deletions: 3, binary: false },
  { path: "tests/documents/test_service.py", old_path: null, change: "added", additions: 74, deletions: 0, binary: false },
  { path: "pnpm-lock.yaml", old_path: null, change: "modified", additions: 220, deletions: 180, binary: false },
  { path: "README.md", old_path: null, change: "modified", additions: 3, deletions: 1, binary: false },
];

const checkpoint: Record<string, unknown> & { id: string; files: typeof files } = {
  id: "cp2",
  session_id: sessionId,
  repository_id: "r1",
  worktree_id: "w1",
  seq: 2,
  base_rev: "base",
  head_rev: "head",
  source: "turn",
  turn_id: "t1",
  files,
  status: "ready",
  created_at: now,
};
const earlier = { ...checkpoint, id: "cp1", seq: 1, files: files.slice(2, 4), created_at: new Date(Date.now() - 3600_000).toISOString() };

const level = (score: number) => (score >= 60 ? "high" : score >= 30 ? "medium" : "low");
const unitLevel = (score: number) => (score >= 45 ? "high" : score >= 20 ? "medium" : "low");
const fileScores = [
  { path: "src/studio/auth/tokens.py", score: 82, reasons: ["touches authentication", "31 lines changed"] },
  { path: "src/studio/documents/service.py", score: 61, reasons: ["73 lines changed", "public contract or entry point"] },
  { path: "src/studio/documents/repositories.py", score: 34, reasons: ["touches database access"] },
  { path: "tests/documents/test_service.py", score: 27, reasons: ["new file", "test file"] },
  { path: "README.md", score: 2, reasons: ["documentation"] },
  { path: "pnpm-lock.yaml", score: 3, reasons: ["generated lockfile"] },
].map((item) => {
  const file = files.find((f) => f.path === item.path)!;
  return { ...item, level: level(item.score), additions: file.additions, deletions: file.deletions, change: file.change };
});
type Factor = [component: string, points: number, reason: string];
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
/** A unit scored the way the app scores it: every point has a reason, the score is their sum. */
const unit = (id: string, name: string, kind: string, path: string, start: number, end: number, factors: Factor[], extra: Record<string, unknown> = {}) => {
  const score = Math.max(0, Math.min(100, factors.reduce((sum, [, points]) => sum + points, 0)));
  const ordered = [...factors].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return {
    id, name, kind, path, start_line: start, end_line: end, side: "head", change: "modified", signature_changed: false, public: false,
    references: 0, additions: 6, deletions: 2, score, level: unitLevel(score),
    reasons: ordered.length ? ordered.map(([, points, reason]) => `${reason} (${signed(points)})`) : ["small, contained change"],
    container: null,
    factors: factors.map(([component, points, reason]) => ({ component, points, reason })),
    complexity: 4, format_only: false, markers: [], entry: null, sensitive: null, tested: null, dirs: 0, generated: false, ...extra,
  };
};
const units = [
  unit("u1", "issue_token", "function", "src/studio/auth/tokens.py", 6, 10,
    [["reach", 8, "exported, so other code can call it"], ["reach", 10, "mentioned in 7 other files"], ["reach", 15, "used from another folder"], ["sensitivity", 15, "touches a sensitive area (`token`)"], ["tests", 8, "no test file mentions it (that does not prove there is no test)"], ["size", 8, "12 lines changed"]],
    { public: true, references: 7, additions: 9, deletions: 3, entry: "internal", sensitive: "token", tested: false, dirs: 1 }),
  unit("u2", "verify", "function", "src/studio/auth/tokens.py", 13, 15,
    [["reach", 8, "exported, so other code can call it"], ["reach", 10, "mentioned in 5 other files"], ["sensitivity", 15, "touches a sensitive area (`token`)"], ["complexity", 8, "complexity grew from 3 to 9"]],
    { public: true, references: 5, entry: "internal", sensitive: "token", tested: true, complexity: 9 }),
  unit("u3", "dispatch", "function", "src/studio/documents/service.py", 4, 5,
    [["contract", 25, "the declaration of a public function changed"], ["reach", 8, "exported, so other code can call it"], ["reach", 15, "used from another folder"], ["tests", 8, "no test file mentions it (that does not prove there is no test)"]],
    { public: true, signature_changed: true, references: 3, entry: "internal", tested: false, dirs: 1 }),
  unit("u4", "DocumentRepository.create", "method", "src/studio/documents/repositories.py", 2, 6,
    [["risk", 15, "error swallowed (already in this code)"], ["reach", 8, "exported, so other code can call it"], ["tests", 8, "no test file mentions it (that does not prove there is no test)"]],
    { container: "DocumentRepository", public: true, entry: "internal", tested: false, markers: [{ rule: "swallowed_error", title: "Error swallowed", line: 5, introduced: false }] }),
  unit("u5", "test_enqueues_job", "function", "tests/documents/test_service.py", 1, 74,
    [["size", 12, "74 lines changed"], ["mitigation", -15, "the file is a test"]], { additions: 74, deletions: 0, change: "added" }),
  { ...unit("u6", "README.md", "file", "README.md", 1, 0, []), score: 3, level: "low", reasons: ["documentation"], additions: 3, deletions: 1 },
];
const components = (() => {
  const groups = new Map<string, typeof units>();
  for (const item of units) {
    const key = item.container ? `${item.path}::${item.container}` : item.path;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].map(([id, members]) => {
    const sorted = [...members].sort((a, b) => b.score - a.score);
    const top = sorted[0]!;
    const score = Math.min(100, top.score + Math.min(10, (members.length - 1) * 2));
    return { id, name: top.container ?? top.path.split("/").pop(), path: top.path, units: sorted.map((m) => m.id), files: [...new Set(sorted.map((m) => m.path))], score, level: unitLevel(score), additions: members.reduce((n, m) => n + m.additions, 0), deletions: members.reduce((n, m) => n + m.deletions, 0), reasons: top.reasons.slice(0, 3) };
  }).sort((a, b) => b.score - a.score);
})();
const priority = {
  files: fileScores,
  units,
  languages: ["python"],
  components,
};

const tree = [...files.map((f) => f.path), "src/studio/__init__.py", "src/studio/documents/__init__.py", "pyproject.toml", ".gitignore"].sort();
// Files "removed in a terminal" from the preview (see `__ataraxiaMock` in tauriMock.ts).
const removed = new Set<string>();
export function removeFile(path: string) {
  removed.add(path);
}
// `?review=none` previews a chat with no checkpoint: nothing is compared until one is picked.
const noReview = new URLSearchParams(globalThis.location?.search ?? "").get("review") === "none";

function sample(path: string, version: "base" | "head"): string {
  if (path.endsWith("tokens.py")) {
    return [
      "import hashlib",
      "import hmac",
      "import secrets",
      "",
      "",
      "def issue_token(user_id: int) -> str:",
      version === "head" ? '    """Return an opaque token; only its hash is stored."""' : '    """Return a signed token."""',
      "    raw = secrets.token_urlsafe(32)",
      version === "head" ? "    store_hash(user_id, hashlib.sha256(raw.encode()).hexdigest())" : "    store(user_id, raw)",
      "    return raw",
      "",
      "",
      "def verify(user_id: int, raw: str) -> bool:",
      version === "head" ? "    expected = load_hash(user_id)" : "    expected = load(user_id)",
      version === "head" ? "    return hmac.compare_digest(expected, hashlib.sha256(raw.encode()).hexdigest())" : "    return expected == raw",
      "",
    ].join("\n");
  }
  if (path.endsWith("service.py")) {
    return [
      "from .repositories import DocumentRepository",
      "",
      "",
      "async def dispatch(job_id: int) -> None:",
      version === "head" ? "    await worker.enqueue(job_id)" : "    await generate(job_id)",
      "",
      "",
      "async def create_document(payload: dict) -> int:",
      "    job_id = await DocumentRepository().create(payload)",
      version === "head" ? "    await dispatch(job_id)\n    return job_id  # 202 Accepted" : "    await dispatch(job_id)\n    return job_id",
      "",
    ].join("\n");
  }
  return `# ${path}\n\nSample content (${version}).\n\nprint("hello")\n`;
}

const contents = new Map<string, { text: string; mtimeMs: number }>();
function read(path: string) {
  if (!contents.has(path)) {
    contents.set(path, { text: sample(path, "head"), mtimeMs: 1_000_000 });
  }
  const entry = contents.get(path)!;
  return { path, text: entry.text, binary: false, tooLarge: false, size: entry.text.length, mtimeMs: entry.mtimeMs };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
type DecisionRow = { id: string; state: string; version: number; checkpoint_id: string; created_at: string; updated_at: string; [key: string]: unknown };
const decisions: DecisionRow[] = new URLSearchParams(globalThis.location?.search ?? "").get("decisions") === "empty" ? [] : [
  {
    id: "d1", session_id: sessionId, checkpoint_id: "cp2", artifact_id: "a2", seq: 1, kind: "security",
    title: "Store only a hash of issued tokens?", summary: "Tokens are returned once and only their SHA-256 hash is persisted, so a database leak does not expose live credentials.",
    context: "The previous implementation stored the token itself next to the user id.",
    rationale: "A hash is enough to verify a token; constant-time comparison avoids timing leaks.",
    alternatives: [{ title: "Encrypt tokens at rest", note: "Needs key management and keeps tokens recoverable." }, { title: "Keep plain tokens", note: "Simplest, but a leak is a breach." }],
    refs: [{ path: "src/studio/auth/tokens.py", start_line: 6, end_line: 15 }],
    state: "pending", version: 1, superseded_by: null, opened_by: "claude · sonnet", created_at: minutesAgo(190), updated_at: minutesAgo(40),
  },
  {
    id: "d2", session_id: sessionId, checkpoint_id: "cp2", artifact_id: "a2", seq: 2, kind: "api-contract",
    title: "Return 202 Accepted from POST /documents", summary: "Document creation now answers immediately and a worker generates the file, so clients must poll for the result.",
    context: "Generation can take longer than a request timeout.", rationale: "Decouples request latency from generation time.",
    alternatives: [{ title: "Keep it synchronous", note: "Simple, but times out on large documents." }],
    refs: [{ path: "src/studio/documents/service.py", start_line: 4, end_line: 10 }],
    state: "approved", version: 2, superseded_by: null, opened_by: "agent", created_at: minutesAgo(180), updated_at: minutesAgo(30),
  },
  {
    id: "d3", session_id: sessionId, checkpoint_id: "cp1", artifact_id: "a1", seq: 3, kind: "dependencies",
    title: "Write the retry helper locally", summary: "A small retry helper is added instead of a new dependency.",
    context: "", rationale: "", alternatives: [], refs: [], state: "pending", version: 1, superseded_by: null, opened_by: "you", created_at: minutesAgo(60 * 26), updated_at: minutesAgo(60 * 26),
  },
];
const messages = new Map<string, unknown[]>([
  ["d1", [{ id: "m1", decision_id: "d1", author: "user", text: "Why SHA-256 and not a slow hash?", code_ref: null, created_at: minutesAgo(120) }, { id: "m2", decision_id: "d1", author: "agent", text: "Tokens are 256 bits of randomness, so brute force is not the threat a slow hash defends against. A fast hash keeps verification cheap on every request.", code_ref: null, created_at: minutesAgo(119) }]],
]);
const linkedCommits = new Map<string, Record<string, unknown>[]>([
  ["d1", [{ decision_id: "d1", rev: "b3c4d5e6bbbb", short: "b3c4d5e", subject: "Hash tokens before storing them", author: "Ana", committed_at: minutesAgo(70), note: "Implements the hashing; the plain token is no longer persisted.", linked_by: "agent", created_at: minutesAgo(65) }]],
]);
const candidatePool = [
  { rev: "d76d97b4aaaa", short: "d76d97b", subject: "Add course mask", date: minutesAgo(15), author: "Ana" },
  { rev: "b3c4d5e6bbbb", short: "b3c4d5e", subject: "Hash tokens before storing them", date: minutesAgo(70), author: "Ana" },
  { rev: "c9d8e7f6cccc", short: "c9d8e7f", subject: "Fix retry backoff", date: minutesAgo(300), author: "Rui" },
];
let generated = 0;
let generating: Record<string, unknown> | null = null;

const flowContent = {
  summary: "A request enters the API, is validated, queued and processed by a worker.",
  generatedAt: now,
  nodes: [
    { id: "api", label: "POST /documents", kind: "entry", description: "Receives the request and answers 202.", refs: [{ path: "src/studio/documents/service.py", start_line: 8, end_line: 8 }], verified: true },
    { id: "validate", label: "Validate payload", kind: "function", description: "Checks the payload against the schema.", refs: [], verified: false },
    { id: "repo", label: "DocumentRepository", kind: "component", description: "Persists the job.", refs: [{ path: "src/studio/documents/repositories.py", start_line: 1, end_line: 3 }], verified: true },
    { id: "queue", label: "worker.enqueue", kind: "function", description: "Hands the job to the worker.", refs: [{ path: "src/studio/documents/service.py", start_line: 4, end_line: 5 }], verified: true },
    { id: "worker", label: "Worker", kind: "component", description: "Generates the document and records progress.", refs: [], verified: false },
    { id: "store", label: "Object storage", kind: "external", description: "Holds the finished file.", refs: [], verified: false },
  ],
  edges: [
    { id: "e0", source: "api", target: "validate", label: "calls" },
    { id: "e1", source: "validate", target: "repo", label: "creates job" },
    { id: "e2", source: "repo", target: "queue", label: "job id" },
    { id: "e3", source: "queue", target: "worker", label: "enqueues" },
    { id: "e4", source: "worker", target: "store", label: "writes" },
  ],
};

let flows: Record<string, unknown>[] = [];
let flowCount = 0;

const presets = [
  ["Execution flow", "Trace how execution moves through the code."],
  ["Architecture", "Show the components of the system and how they depend on each other."],
  ["Data flow", "Follow the data from where it enters to where it is stored."],
  ["API request cycle", "Show the life of an API request."],
].map(([name, prompt], index) => ({ id: `p${index + 1}`, repository_id: null, name, prompt, version: 1, builtin: true, created_at: now, updated_at: now }));

const artifactList = () => [
  { id: "a3", session_id: sessionId, checkpoint_id: "cp2", kind: "review_priority", dedupe_key: "", version: 1, status: "ready", content: priority, provenance: {}, error: null, created_at: now, updated_at: now },
  { id: "a2", session_id: sessionId, checkpoint_id: "cp2", kind: "decision", dedupe_key: "", version: 1, status: "ready", content: { count: 2 }, provenance: {}, error: null, created_at: now, updated_at: now },
  { id: "a1", session_id: sessionId, checkpoint_id: "cp1", kind: "decision", dedupe_key: "", version: 1, status: "failed", content: {}, provenance: {}, error: "The agent took too long to answer", created_at: now, updated_at: now },
  ...(generating ? [generating] : []),
  ...flows,
];

type Task = Record<string, unknown> & { status: string; summary: string | null };
let btwTasks: Task[] = [];

export function handleInsights(cmd: string, args: Record<string, unknown> | undefined, emit: Emit): { handled: boolean; value?: unknown } {
  const ok = (value: unknown) => ({ handled: true, value });
  switch (cmd) {
    case "code_tree": return ok(tree.filter((path) => !removed.has(path)));
    case "code_read":
      if (removed.has(String(args?.path))) {
        throw new Error(`error[not-found]: ${String(args?.path)} does not exist`);
      }
      return ok(read(String(args?.path)));
    case "code_write": {
      const path = String(args?.path);
      const entry = contents.get(path) ?? { text: "", mtimeMs: 1_000_000 };
      entry.text = String(args?.text);
      entry.mtimeMs += 1000;
      contents.set(path, entry);
      return ok(entry.mtimeMs);
    }
    case "code_file_at": return ok(args?.side === "base" ? sample(String(args?.path), "base") : sample(String(args?.path), "head"));
    case "code_review": {
      if (noReview && !args?.checkpointId) {
        return ok({ checkpoints: [], checkpoint: null, priority: null, marks: [], comments: [], artifacts: [] });
      }
      const target = args?.checkpointId === "cp1" ? earlier : args?.checkpointId === "cp-compare" ? { ...checkpoint, id: "cp-compare", seq: 3, source: "compare", base_label: "main (merge base)", head_label: "feature/x", head_live: false } : checkpoint;
      return ok({ checkpoints: target.id === "cp-compare" ? [earlier, checkpoint, target] : [earlier, checkpoint], checkpoint: target, priority: target === checkpoint ? priority : { files: fileScores.slice(2, 4), components: priority.components.slice(1, 3) }, marks: [{ checkpoint_id: "cp2", path: "src/studio/documents/service.py", state: "approved", updated_at: now }], comments: [{ id: "c1", checkpoint_id: "cp2", path: "src/studio/auth/tokens.py", line: 9, side: "head", text: "Should the hash be salted per user?", created_at: now }], artifacts: artifactList().filter((a) => a.checkpoint_id === target.id) });
    }
    case "code_refresh_checkpoint": return ok(checkpoint);
    case "code_refs": return ok({
      current: "feature/course-mask",
      refs: [
        { name: "feature/course-mask", kind: "branch", rev: "d76d97b4", subject: "Add course mask" },
        { name: "main", kind: "branch", rev: "a1b2c3d4", subject: "Merge pull request #42" },
        { name: "origin/main", kind: "remote", rev: "a1b2c3d4", subject: "Merge pull request #42" },
        { name: "v2.3.0", kind: "tag", rev: "99aa", subject: "Release 2.3.0" },
      ],
      commits: [
        { rev: "d76d97b4aaaa", short: "d76d97b", subject: "Add course mask", date: now },
        { rev: "b3c4d5e6bbbb", short: "b3c4d5e", subject: "Fix retry backoff", date: now },
      ],
    });
    case "code_compare": return ok({ ...checkpoint, id: "cp-compare", seq: 3, source: "compare", base_label: args?.mergeBase ? `${String(args?.base)} (merge base)` : args?.base, head_label: args?.head ?? "working tree", head_live: args?.head === null, turn_id: null });
    case "code_set_review_mark": return ok({ checkpoint_id: args?.checkpointId, path: args?.path, state: args?.reviewState, updated_at: now });
    case "code_add_comment": return ok({ id: crypto.randomUUID(), checkpoint_id: args?.checkpointId, path: args?.path, line: args?.line ?? null, side: args?.side, text: args?.text, created_at: now });
    case "checkpoints_list": return ok([earlier, checkpoint]);
    case "artifacts_list": return ok(artifactList());
    case "artifact_retry": return ok(artifactList()[0]);
    case "decisions_generate": {
      if (generating && generating.status === "running") {
        throw new Error("decisions are already being generated for this chat");
      }
      generated += 1;
      const provider = String(args?.provider ?? "claude");
      const model = args?.model ? String(args.model) : null;
      const run: Record<string, unknown> = { id: "g" + generated, session_id: sessionId, checkpoint_id: String(args?.checkpointId ?? "cp2"), kind: "decision", dedupe_key: "g" + generated, version: 1, status: "running", content: {}, provenance: { provider, model }, error: null, created_at: now, updated_at: now };
      generating = run;
      setTimeout(() => {
        const seq = decisions.length + 1;
        decisions.push({ id: "d" + (10 + generated), session_id: sessionId, checkpoint_id: String(run.checkpoint_id), artifact_id: run.id, seq, kind: "performance", title: "Cap retries at three attempts?", summary: "The retry helper gives up after three attempts instead of looping, so a failing worker cannot hold a job forever.", context: "", rationale: "", alternatives: [], refs: [{ path: "src/studio/documents/service.py", start_line: 4, end_line: 5 }], state: "pending", version: 1, superseded_by: null, opened_by: model ? `${provider} · ${model}` : provider, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        run.status = "ready";
        run.content = { count: 1, extended: 0 };
        emit("insight://event", { type: "decisions", sessionId });
      }, 900);
      return ok(run);
    }
    case "decision_create": {
      const seq = decisions.length + 1;
      const summary = String(args?.summary ?? "").trim();
      const created = { id: "d" + (20 + seq), session_id: sessionId, checkpoint_id: "cp2", artifact_id: null, seq, kind: args?.kind ?? "other", title: String(args?.title), summary: summary || String(args?.title), context: "", rationale: "", alternatives: [], refs: [], state: "pending", version: 1, superseded_by: null, opened_by: "you", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      decisions.push(created);
      return ok(created);
    }
    case "decision_link_commit": {
      const id = String(args?.decisionId);
      const wanted = String(args?.rev);
      const found = candidatePool.find((c) => c.rev.startsWith(wanted) || c.short === wanted);
      if (!found) {
        throw new Error(`\`${wanted}\` is not a branch, tag or commit here`);
      }
      const list = (linkedCommits.get(id) ?? []).filter((c) => c.rev !== found.rev);
      const linked = { decision_id: id, rev: found.rev, short: found.short, subject: found.subject, author: found.author, committed_at: found.date, note: String(args?.note ?? ""), linked_by: "user", created_at: new Date().toISOString() };
      linkedCommits.set(id, [...list, linked]);
      emit("insight://event", { type: "decisionThread", decisionId: id });
      return ok(linked);
    }
    case "decision_unlink_commit": {
      const id = String(args?.decisionId);
      linkedCommits.set(id, (linkedCommits.get(id) ?? []).filter((c) => c.rev !== args?.rev));
      emit("insight://event", { type: "decisionThread", decisionId: id });
      return ok(null);
    }
    case "decision_commit_candidates": {
      const id = String(args?.decisionId);
      const linked = (linkedCommits.get(id) ?? []).map((c) => c.rev);
      const touching = id === "d1" ? ["d76d97b4aaaa", "b3c4d5e6bbbb"] : id === "d2" ? ["c9d8e7f6cccc"] : [];
      return ok([...candidatePool].sort((a, b) => Number(touching.includes(b.rev)) - Number(touching.includes(a.rev))).map((commit) => ({ commit, touchesDecisionFiles: touching.includes(commit.rev), linked: linked.includes(commit.rev) })));
    }
    case "decisions_list": return ok(decisions.map((item) => ({ ...item })));
    case "decision_detail": {
      const decision = decisions.find((d) => d.id === args?.decisionId)!;
      return ok({ decision, messages: messages.get(decision.id) ?? [], commits: linkedCommits.get(decision.id) ?? [], revisions: [{ decision_id: decision.id, version: 1, reason: "created", created_at: decision.created_at }, ...(decision.version > 1 ? [{ decision_id: decision.id, version: 2, reason: decision.state === "rejected" ? "state:rejected" : decision.state === "pending" ? "state:pending" : "state:approved", created_at: decision.updated_at }] : [])], laterChanges: decision.id === "d1" ? [] : [{ checkpointId: "cp3", seq: 3, paths: ["src/studio/documents/service.py"] }], checkpointSeq: decision.checkpoint_id === "cp2" ? 2 : 1 });
    }
    case "decision_set_state": {
      const decision = decisions.find((d) => d.id === args?.decisionId)!;
      const note = String(args?.comment ?? "").trim();
      if (note) {
        messages.set(decision.id, [...(messages.get(decision.id) ?? []), { id: crypto.randomUUID(), decision_id: decision.id, author: "user", text: note, code_ref: null, created_at: new Date().toISOString() }]);
      }
      decision.state = String(args?.decisionState);
      decision.version += 1;
      decision.updated_at = new Date().toISOString();
      return ok({ ...decision });
    }
    case "decision_comment": {
      const id = String(args?.decisionId);
      const message = { id: crypto.randomUUID(), decision_id: id, author: "user", text: String(args?.text), code_ref: null, created_at: new Date().toISOString() };
      messages.set(id, [...(messages.get(id) ?? []), message]);
      return ok(message);
    }
    case "decision_post_message": {
      const id = String(args?.decisionId);
      const list = messages.get(id) ?? [];
      const message = { id: crypto.randomUUID(), decision_id: id, author: "user", text: args?.text, code_ref: null, created_at: new Date().toISOString() };
      list.push(message);
      messages.set(id, list);
      setTimeout(() => {
        list.push({ id: crypto.randomUUID(), decision_id: id, author: "agent", text: "Good question. Nothing was changed: this is only my reading of the code.", code_ref: null, created_at: new Date().toISOString() });
        emit("insight://event", { type: "decisionThread", decisionId: id });
      }, 700);
      return ok(message);
    }
    case "decision_request_change": return ok("t2");
    case "btw_preview_context": return ok("Repository: archipelago-backend\nBranch: feature/course-mask\nChat: Refactor document generation\nSpace: code\nFile: src/studio/auth/tokens.py:6-15\n```\ndef issue_token(user_id: int) -> str:\n    ...\n```\n");
    case "btw_start": {
      const question = String(args?.question ?? "");
      const acts = /comment|priority|decision|diagram|flow/i.test(question);
      const task: Task = { id: crypto.randomUUID(), parent_session_id: sessionId, session_id: "btw-" + btwTasks.length, mode: args?.mode, question, context_text: "", return_policy: "on-completion", summary: null, returned_at: null, status: "running", created_at: now, updated_at: now };
      btwTasks = [task, ...btwTasks];
      const block = '\n\n```ataraxia-actions\n[{"type":"comment","path":"src/studio/auth/tokens.py","unit":"issue_token","text":"Why a fast hash here?"},{"type":"priority","path":"src/studio/auth/tokens.py","unit":"verify","score":90,"reason":"it gates every request"}]\n```';
      setTimeout(() => {
        emit("agent://event", { type: "delta", sessionId: task.session_id, turnId: "t9", role: "assistant", text: acts ? "I left a comment on issue_token and raised verify, since it gates every request." : "It hashes the token with SHA-256 " });
        emit("agent://event", { type: "delta", sessionId: task.session_id, turnId: "t9", role: "assistant", text: acts ? block : "and compares in constant time. Nothing was modified." });
        emit("agent://event", { type: "turnDone", sessionId: task.session_id, turnId: "t9", ok: true });
        task.status = "ready";
        task.summary = acts
          ? "I left a comment on issue_token and raised verify, since it gates every request.\n\nDone in Ataraxia:\n- Commented on `issue_token` (src/studio/auth/tokens.py:6)\n- Set the priority of `verify` to 90 (it was 41)\n- Could not comment: `nope` is not in the review queue"
          : "It hashes the token with SHA-256 and compares in constant time.";
        task.updated_at = new Date().toISOString();
        emit("insight://event", { type: "btw", taskId: task.id, parentSessionId: sessionId, status: "ready" });
        setTimeout(() => {
          task.returned_at = new Date(Date.now() + 1).toISOString();
          task.updated_at = task.returned_at;
          emit("insight://event", { type: "btw", taskId: task.id, parentSessionId: sessionId, status: "ready" });
        }, 400);
      }, 500);
      return ok(task);
    }
    case "btw_list": return ok(btwTasks.map((item) => ({ ...item })));
    case "btw_return": return ok(null);
    case "btw_session": return ok({ id: "btw-0", repository_id: "r1", worktree_id: "w1", provider: "fake", title: "BTW: " + String(btwTasks[0]?.question ?? ""), status: "ready", model: null, effort: null, agent: null, kind: "btw", parent_session_id: sessionId, created_at: now, updated_at: now, last_opened_at: null });
    case "flow_presets": return ok(presets);
    case "flow_save_preset": {
      const saved = { id: String(args?.presetId ?? "p" + (presets.length + 1)), repository_id: args?.repositoryId ?? null, name: args?.name, prompt: args?.prompt, version: 1, builtin: false, created_at: now, updated_at: now };
      const at = presets.findIndex((p) => p.id === saved.id);
      if (at >= 0) { Object.assign(presets[at]!, { name: saved.name, prompt: saved.prompt, version: presets[at]!.version + 1 }); return ok(presets[at]); }
      presets.push(saved as (typeof presets)[number]);
      return ok(saved);
    }
    case "flow_delete_preset": return ok(null);
    case "flow_list": return ok(flows);
    case "dev_agent_flow": {
      // What the agent does through the local API: a diagram appears with nobody pressing Generate.
      flowCount += 1;
      const artifact = { id: "f" + flowCount, session_id: sessionId, checkpoint_id: "cp2", kind: "flow", dedupe_key: String(flowCount), version: flowCount, status: "ready", content: flowContent, provenance: { presetName: "Drawn by the agent", prompt: "", extra: "" }, error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      flows = [artifact, ...flows];
      emit("insight://event", { type: "artifact", sessionId, artifactId: artifact.id, kind: "flow", status: "ready" });
      return ok(artifact);
    }
    case "flow_generate": {
      flowCount += 1;
      const preset = presets.find((p) => p.id === args?.presetId)!;
      const artifact = { id: "f" + flowCount, session_id: sessionId, checkpoint_id: "cp2", kind: "flow", dedupe_key: String(flowCount), version: flowCount, status: "running", content: {}, provenance: { presetName: preset.name, prompt: preset.prompt, extra: args?.extra }, error: null, created_at: now, updated_at: now };
      flows = [artifact, ...flows];
      setTimeout(() => {
        artifact.status = "ready";
        artifact.content = flowContent;
        emit("insight://event", { type: "artifact", sessionId, artifactId: artifact.id, kind: "flow", status: "ready" });
      }, 900);
      return ok(artifact);
    }
    default: return { handled: false };
  }
}
