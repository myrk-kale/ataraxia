import { useCallback, useEffect, useMemo, useState } from "react";
import { errorText } from "../lib/useInsightEvents";
import {
  EMPTY_MCP_FORM,
  SCOPE_LABEL,
  markSummary,
  mcpConfigFromForm,
  mcpFormFromConfig,
  resourcesDeleteMcp,
  resourcesDeleteSkill,
  resourcesList,
  resourcesReadMcp,
  resourcesReadSkill,
  resourcesSaveMcp,
  resourcesSaveSkill,
  resourcesSetState,
  type McpForm,
  type ResourceContext,
  type ResourceItem,
  type ResourceKind,
  type ResourceList,
  type ResourceMark,
  type ResourceScope,
} from "../lib/resources";
import type { RepositoryId, WorkspaceId } from "../lib/workspace";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Dialog, Segmented, Toggle } from "../ui/Overlay";

const KINDS = [
  { id: "skill", label: "Skills" },
  { id: "mcp", label: "MCP servers" },
] as const;

const MARKS: readonly { id: ResourceMark; label: string }[] = [
  { id: "inherit", label: "Inherit" },
  { id: "on", label: "On" },
  { id: "off", label: "Off" },
];

/**
 * Skills and MCP servers: which exist where, and which are on. Three scopes, each narrower than the
 * last: global, the workspace, and the project (the repository in focus). A scope turns an item
 * on, off, or leaves it to the broader one; the narrowest to say something wins. It can also hold
 * definitions of its own. Agents read all of this when a session starts.
 */
export function ResourcesSettings({
  workspace,
  repository,
}: {
  workspace: { id: WorkspaceId; name: string } | null;
  repository: { id: RepositoryId; name: string } | null;
}) {
  const [scope, setScope] = useState<ResourceScope>("global");
  const [kind, setKind] = useState<ResourceKind>("skill");
  const [list, setList] = useState<ResourceList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [form, setForm] = useState<{ kind: ResourceKind; editing: string | null } | null>(null);

  // A scope that has nothing to point at (no workspace, no repository) falls back to a broader one.
  const available: ResourceScope[] = useMemo(
    () => ["global", ...(workspace ? (["workspace"] as const) : []), ...(repository ? (["project"] as const) : [])],
    [workspace, repository],
  );
  const shown: ResourceScope = available.includes(scope) ? scope : "global";
  const context: ResourceContext = useMemo(
    () => ({ scope: shown, workspaceId: workspace?.id ?? null, repositoryId: repository?.id ?? null }),
    [shown, workspace?.id, repository?.id],
  );

  const reload = useCallback(async () => {
    try {
      setList(await resourcesList(context));
      setProblem(null);
    } catch (err) {
      setProblem(errorText(err));
    }
  }, [context]);
  useEffect(() => {
    setList(null);
    void reload();
  }, [reload]);

  async function mark(item: ResourceItem, next: ResourceMark) {
    try {
      await resourcesSetState(context, item.kind, item.id, next);
      await reload();
    } catch (err) {
      setProblem(errorText(err));
    }
  }

  async function remove(item: ResourceItem) {
    if (!window.confirm(`Delete ${item.kind === "skill" ? "the skill" : "the MCP server"} "${item.id}" from the ${SCOPE_LABEL[shown].toLowerCase()} scope?`)) {
      return;
    }
    try {
      await (item.kind === "skill" ? resourcesDeleteSkill(context, item.id) : resourcesDeleteMcp(context, item.id));
      await reload();
    } catch (err) {
      setProblem(errorText(err));
    }
  }

  const items = (kind === "skill" ? list?.skills : list?.mcps) ?? [];
  const scopeOptions = available.map((id) => ({
    id,
    label: id === "workspace" ? `Workspace: ${workspace?.name ?? ""}` : id === "project" ? `Project: ${repository?.name ?? ""}` : "Global",
  }));
  const where = {
    global: "all your workspaces and projects",
    workspace: `every chat in ${workspace?.name ?? "this workspace"}`,
    project: `chats working in ${repository?.name ?? "this project"}`,
  }[shown];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Segmented label="Scope" options={scopeOptions} value={shown} onChange={setScope} />
        <p className="text-small leading-5 text-cg-muted-strong">
          Editing what applies to {where}. {shown === "global" ? "" : "Each item can follow the broader scope (Inherit) or be set here."}{" "}
          Agents read this when a session starts, so changes reach new sessions.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented label="Kind" options={KINDS} value={kind} onChange={setKind} />
        <Button variant="quiet" onClick={() => setForm({ kind, editing: null })}>
          {kind === "skill" ? "New skill…" : "Add MCP server…"}
        </Button>
      </div>

      {problem ? (
        <p className="text-small text-cg-red" role="alert">
          {problem}
        </p>
      ) : null}
      {(list?.problems ?? []).map((text) => (
        <p key={text} className="text-small text-cg-amber-text" role="status">
          {text}
        </p>
      ))}
      {shown === "project" && kind === "mcp" ? (
        <p className="text-small leading-5 text-cg-muted-strong">
          A project's servers live in the repository's <code className="font-mono">.mcp.json</code>. Changing that file asks for
          approval again before an agent uses it.
        </p>
      ) : null}

      {list === null && !problem ? (
        <p className="text-small text-cg-muted-strong">Reading…</p>
      ) : items.length === 0 ? (
        <p className="rounded-cg-md border border-dashed border-cg-line px-4 py-6 text-center text-small text-cg-muted-strong">
          {kind === "skill" ? "No skills here yet." : "No MCP servers here yet."} {kind === "skill" ? "New skill…" : "Add MCP server…"} defines one
          for the {SCOPE_LABEL[shown].toLowerCase()} scope.
        </p>
      ) : (
        <ul className="flex flex-col rounded-cg-md border border-cg-line">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`} className="flex flex-col gap-2 border-b border-cg-line px-3 py-2.5 last:border-b-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`truncate font-mono text-ui ${item.effective ? "text-cg-ink" : "text-cg-muted line-through"}`}>{item.id}</span>
                    {item.definedIn !== shown ? <Chip>{SCOPE_LABEL[item.definedIn]}</Chip> : null}
                  </div>
                  <p className="line-clamp-2 text-small leading-5 text-cg-muted-strong" title={item.description}>
                    {item.description}
                  </p>
                </div>
                <div className="flex flex-none items-center gap-2">
                  {shown === "global" ? (
                    <Toggle
                      hideLabel
                      isSelected={item.effective}
                      label={`${item.id} is on`}
                      onChange={(on) => void mark(item, on ? "on" : "off")}
                    />
                  ) : (
                    <div aria-label={`${item.id} here`} className="inline-flex rounded-cg-md border border-cg-line p-0.5" role="group">
                      {MARKS.map((option) => (
                        <button
                          key={option.id}
                          aria-pressed={item.state === option.id}
                          className={`rounded-cg-sm px-2.5 py-1 text-small ${
                            item.state === option.id ? "bg-cg-tint font-semibold text-cg-ink" : "text-cg-muted-strong hover:text-cg-ink"
                          }`}
                          type="button"
                          onClick={() => void mark(item, option.id)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-small text-cg-muted-strong">{markSummary(item)}</span>
                {item.definedIn === shown ? (
                  <span className="flex gap-1.5">
                    <Button variant="quiet" onClick={() => setForm({ kind: item.kind, editing: item.id })}>
                      Edit
                    </Button>
                    <Button variant="quiet" onClick={() => void remove(item)}>
                      Delete
                    </Button>
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <SkillDialog
        context={context}
        editing={form?.kind === "skill" ? form.editing : null}
        isOpen={form?.kind === "skill"}
        onClose={() => setForm(null)}
        onSaved={() => void reload()}
      />
      <McpDialog
        context={context}
        editing={form?.kind === "mcp" ? form.editing : null}
        isOpen={form?.kind === "mcp"}
        onClose={() => setForm(null)}
        onSaved={() => void reload()}
      />
    </div>
  );
}

const FIELD =
  "w-full rounded-cg-md border border-cg-control bg-cg-panel px-3 py-1.5 text-ui text-cg-ink focus:border-cg-ink";

function SkillDialog({
  isOpen,
  context,
  editing,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  context: ResourceContext;
  editing: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setName(editing ?? "");
    setDescription("");
    setBody("");
    setProblem(null);
    setBusy(false);
    if (!editing) {
      return;
    }
    let live = true;
    resourcesReadSkill(context, editing)
      .then((text) => {
        if (live) {
          setDescription(text.description);
          setBody(text.body);
        }
      })
      .catch((err: unknown) => live && setProblem(errorText(err)));
    return () => {
      live = false;
    };
    // The context is read once when the dialog opens: it cannot change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editing]);

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      await resourcesSaveSkill(context, name.trim(), description, body, editing !== null);
      onSaved();
      onClose();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog isOpen={isOpen} label={editing ? "Edit skill" : "New skill"} size="md" onClose={onClose}>
      <form
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 className="text-heading font-semibold text-cg-ink">{editing ? `Edit ${editing}` : "New skill"}</h2>
        <p className="text-small leading-5 text-cg-muted-strong">
          Saved in the {SCOPE_LABEL[context.scope].toLowerCase()} scope as a <code className="font-mono">SKILL.md</code>. The description is
          how an agent decides to use it.
        </p>
        <label className="flex flex-col gap-1.5 text-ui text-cg-ink">
          <span>Name</span>
          <input
            autoComplete="off"
            autoFocus={!editing}
            className={`${FIELD} font-mono disabled:opacity-60`}
            disabled={editing !== null}
            maxLength={64}
            placeholder="review-style"
            spellCheck={false}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <span className="text-small text-cg-muted-strong">Lowercase letters, digits and dashes.</span>
        </label>
        <label className="flex flex-col gap-1.5 text-ui text-cg-ink">
          <span>Description</span>
          <textarea
            className={`${FIELD} min-h-16 resize-y`}
            maxLength={1024}
            placeholder="What it is for, and when to use it"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-ui text-cg-ink">
          <span>Instructions</span>
          <textarea
            className={`${FIELD} min-h-40 resize-y font-mono text-small`}
            placeholder="What the agent should do. Markdown."
            spellCheck={false}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        {problem ? (
          <p className="text-small text-cg-red" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || name.trim() === "" || description.trim() === ""} type="submit" variant="primary">
            {busy ? "Saving…" : "Save skill"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function McpDialog({
  isOpen,
  context,
  editing,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  context: ResourceContext;
  editing: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [form, setForm] = useState<McpForm>(EMPTY_MCP_FORM);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setName(editing ?? "");
    setForm(EMPTY_MCP_FORM);
    setProblem(null);
    setBusy(false);
    if (!editing) {
      return;
    }
    let live = true;
    resourcesReadMcp(context, editing)
      .then((config) => live && setForm(mcpFormFromConfig(config)))
      .catch((err: unknown) => live && setProblem(errorText(err)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editing]);

  const set = (patch: Partial<McpForm>) => setForm((current) => ({ ...current, ...patch }));

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      await resourcesSaveMcp(context, name.trim(), mcpConfigFromForm(form), editing !== null);
      onSaved();
      onClose();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog isOpen={isOpen} label={editing ? "Edit MCP server" : "Add MCP server"} size="md" onClose={onClose}>
      <form
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 className="text-heading font-semibold text-cg-ink">{editing ? `Edit ${editing}` : "Add MCP server"}</h2>
        <p className="text-small leading-5 text-cg-muted-strong">
          Saved in the {SCOPE_LABEL[context.scope].toLowerCase()} scope. Values in the environment and headers are stored as typed
          in that scope's file.
        </p>
        <label className="flex flex-col gap-1.5 text-ui text-cg-ink">
          <span>Name</span>
          <input
            autoComplete="off"
            autoFocus={!editing}
            className={`${FIELD} font-mono disabled:opacity-60`}
            disabled={editing !== null}
            maxLength={64}
            placeholder="docs"
            spellCheck={false}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <Segmented
          label="How it runs"
          options={[
            { id: "command", label: "Local command" },
            { id: "url", label: "Remote URL" },
          ]}
          value={form.kind}
          onChange={(next) => set({ kind: next })}
        />
        {form.kind === "command" ? (
          <>
            <label className="flex flex-col gap-1.5 text-ui text-cg-ink">
              <span>Command</span>
              <input
                autoComplete="off"
                className={`${FIELD} font-mono`}
                placeholder="npx"
                spellCheck={false}
                value={form.command}
                onChange={(event) => set({ command: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-ui text-cg-ink">
              <span>Arguments, one per line</span>
              <textarea
                className={`${FIELD} min-h-20 resize-y font-mono text-small`}
                placeholder={"-y\n@scope/server"}
                spellCheck={false}
                value={form.args}
                onChange={(event) => set({ args: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-ui text-cg-ink">
              <span>Environment, KEY=value per line</span>
              <textarea
                className={`${FIELD} min-h-16 resize-y font-mono text-small`}
                spellCheck={false}
                value={form.env}
                onChange={(event) => set({ env: event.target.value })}
              />
            </label>
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1.5 text-ui text-cg-ink">
              <span>URL</span>
              <input
                autoComplete="off"
                className={`${FIELD} font-mono`}
                placeholder="https://example.com/mcp"
                spellCheck={false}
                value={form.url}
                onChange={(event) => set({ url: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-ui text-cg-ink">
              <span>Headers, KEY=value per line</span>
              <textarea
                className={`${FIELD} min-h-16 resize-y font-mono text-small`}
                spellCheck={false}
                value={form.headers}
                onChange={(event) => set({ headers: event.target.value })}
              />
            </label>
          </>
        )}
        {problem ? (
          <p className="text-small text-cg-red" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || name.trim() === ""} type="submit" variant="primary">
            {busy ? "Saving…" : "Save server"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
