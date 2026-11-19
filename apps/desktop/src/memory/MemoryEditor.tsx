import { ArrowRight, Link2, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  KIND_HINT,
  KIND_LABEL,
  KIND_ORDER,
  RELATION_INVERSE_LABEL,
  RELATION_LABEL,
  RELATION_ORDER,
  SOURCE_LABEL,
  isExpired,
  memoryCreate,
  memoryDelete,
  memoryLink,
  memoryUnlink,
  memoryUpdate,
  parseTags,
  type Memory,
  type MemoryKind,
  type MemoryLink,
  type Relation,
} from "../lib/memory";
import { errorText } from "../lib/useInsightEvents";
import type { WorkspaceId } from "../lib/workspace";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { QuietSelect } from "../ui/QuietSelect";

export type WorkspaceName = { id: WorkspaceId; name: string };

const FIELD = "w-full rounded-cg-md border border-cg-control bg-cg-panel px-2.5 py-1.5 text-ui text-cg-ink placeholder:text-cg-muted";
const LABEL = "text-small font-medium text-cg-muted-strong";

/** `global`, or a workspace's id: what the scope picker holds. */
export const GLOBAL = "global";

export function scopeName(memory: Pick<Memory, "workspaceId">, workspaces: readonly WorkspaceName[]): string {
  if (memory.workspaceId === null) {
    return "Global";
  }
  return workspaces.find((item) => item.id === memory.workspaceId)?.name ?? "A removed workspace";
}

function formatDate(moment: string): string {
  const date = new Date(moment);
  return Number.isNaN(date.getTime()) ? moment : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * One memory, to read, edit, link and delete; or, with `memory` null, to write a new one. What
 * the agents saved reads the same as what you write: it is all text you can correct or remove.
 */
export function MemoryEditor({
  memory,
  memories,
  links,
  workspaces,
  defaultScope,
  onChanged,
  onSelect,
  onClose,
  onError,
}: {
  memory: Memory | null;
  memories: readonly Memory[];
  links: readonly MemoryLink[];
  workspaces: readonly WorkspaceName[];
  /** Where a new memory goes unless changed: global, or a workspace id. */
  defaultScope: string;
  /** Something changed on disk: read it again. `select` names the memory to show next, if any. */
  onChanged: (select?: string | null) => void;
  onSelect: (id: string) => void;
  onClose?: () => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<MemoryKind>("semantic");
  const [scope, setScope] = useState(defaultScope);
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // The fields follow the memory on show, and follow it again when it changes under them.
  useEffect(() => {
    setTitle(memory?.title ?? "");
    setBody(memory?.body ?? "");
    setKind(memory?.kind ?? "semantic");
    setScope(memory ? (memory.workspaceId ?? GLOBAL) : defaultScope);
    setTags(memory?.tags.join(", ") ?? "");
    setConfirming(false);
  }, [memory?.id, memory?.updatedAt, defaultScope]);

  const scopeOptions = useMemo(
    () => [
      { value: GLOBAL, label: "Global", hint: "Every workspace" },
      ...workspaces.map((item) => ({ value: item.id as string, label: item.name, hint: "This workspace only" })),
    ],
    [workspaces],
  );
  const scopeId = (value: string): WorkspaceId | null => (value === GLOBAL ? null : (value as WorkspaceId));

  const dirty =
    memory === null
      ? title.trim() !== "" || body.trim() !== ""
      : title !== memory.title ||
        body !== memory.body ||
        kind !== memory.kind ||
        scope !== (memory.workspaceId ?? GLOBAL) ||
        parseTags(tags).join(",") !== memory.tags.join(",");
  const complete = title.trim() !== "" && body.trim() !== "";

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      return true;
    } catch (err) {
      onError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    let saved: Memory | null = null;
    const ok = await run(async () => {
      saved =
        memory === null
          ? await memoryCreate({ kind, workspaceId: scopeId(scope), title, body, tags: parseTags(tags) })
          : await memoryUpdate(memory.id, { kind, workspaceId: scopeId(scope), title, body, tags: parseTags(tags) });
    });
    if (ok) {
      onChanged((saved as Memory | null)?.id ?? null);
    }
  }

  async function remove() {
    if (memory && (await run(() => memoryDelete(memory.id)))) {
      onChanged(null);
    }
  }

  const mine = memory ? links.filter((link) => link.fromId === memory.id || link.toId === memory.id) : [];
  const byId = useMemo(() => new Map(memories.map((item) => [item.id, item])), [memories]);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-ui font-semibold text-cg-ink">{memory ? "Memory" : "New memory"}</h3>
        {onClose ? (
          <Button aria-label="Close" variant="icon" onClick={onClose}>
            <X aria-hidden="true" size={15} />
          </Button>
        ) : null}
      </div>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Title</span>
        <input
          className={FIELD}
          maxLength={120}
          placeholder="One line: the fact"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Body</span>
        <textarea
          className={`${FIELD} min-h-28 resize-y leading-6`}
          maxLength={6000}
          placeholder="The fact and why, in a few sentences. Never a password or a key."
          rows={5}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <span className={LABEL}>Kind</span>
          <QuietSelect
            aria-label="Kind"
            options={KIND_ORDER.map((item) => ({ value: item, label: KIND_LABEL[item], hint: KIND_HINT[item] }))}
            value={kind}
            variant="chip"
            onChange={(value) => setKind(value as MemoryKind)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className={LABEL}>Scope</span>
          <QuietSelect aria-label="Scope" options={scopeOptions} value={scope} variant="chip" onChange={setScope} />
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Tags</span>
        <input className={FIELD} placeholder="auth, build (comma separated)" value={tags} onChange={(event) => setTags(event.target.value)} />
      </label>

      {memory ? (
        <p className="flex flex-wrap items-center gap-1.5 text-small text-cg-muted-strong">
          <Chip title="Who stood behind it when it was written">{SOURCE_LABEL[memory.source]}</Chip>
          <span>
            written by {memory.author === "agent" ? "an agent" : "you"}, {formatDate(memory.updatedAt)}
          </span>
          {memory.expiresAt ? (
            <Chip tone={isExpired(memory) ? "attention" : "neutral"}>
              {isExpired(memory) ? "Expired" : "Expires"} {formatDate(memory.expiresAt)}
            </Chip>
          ) : null}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || !dirty || !complete} variant="primary" onClick={() => void save()}>
          {memory ? "Save" : "Add memory"}
        </Button>
        {memory ? (
          confirming ? (
            <>
              <Button disabled={busy} variant="danger" onClick={() => void remove()}>
                Delete for good
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button variant="quiet" onClick={() => setConfirming(true)}>
              <Trash2 aria-hidden="true" size={13} /> Delete
            </Button>
          )
        ) : null}
      </div>

      {memory ? (
        <section aria-label="Links" className="flex flex-col gap-2 border-t border-cg-line pt-3">
          <h4 className={LABEL}>Links</h4>
          {mine.length === 0 ? <p className="text-small text-cg-muted">Not linked to anything yet.</p> : null}
          <ul className="flex flex-col gap-1">
            {mine.map((link) => {
              const outgoing = link.fromId === memory.id;
              const other = byId.get(outgoing ? link.toId : link.fromId);
              return (
                <li key={`${link.fromId}-${link.toId}-${link.relation}`} className="flex items-center gap-1.5 text-small">
                  <span className="flex-none text-cg-muted-strong">
                    {outgoing ? RELATION_LABEL[link.relation] : RELATION_INVERSE_LABEL[link.relation]}
                  </span>
                  <button
                    className="min-w-0 flex-1 truncate rounded-cg-sm px-1 text-left text-cg-accent hover:underline"
                    disabled={!other}
                    type="button"
                    onClick={() => other && onSelect(other.id)}
                  >
                    {other?.title ?? "a memory you cannot see"}
                  </button>
                  <Button
                    aria-label={`Remove the link to ${other?.title ?? "this memory"}`}
                    disabled={busy}
                    variant="icon"
                    onClick={() =>
                      void run(() => memoryUnlink(link.fromId, link.toId, link.relation)).then((ok) => ok && onChanged(memory.id))
                    }
                  >
                    <X aria-hidden="true" size={13} />
                  </Button>
                </li>
              );
            })}
          </ul>
          <AddLink
            busy={busy}
            candidates={memories.filter((item) => item.id !== memory.id)}
            onLink={(target, relation) =>
              void run(() => memoryLink(memory.id, target, relation)).then((ok) => ok && onChanged(memory.id))
            }
          />
        </section>
      ) : null}
    </div>
  );
}

function AddLink({
  candidates,
  busy,
  onLink,
}: {
  candidates: readonly Memory[];
  busy: boolean;
  onLink: (target: string, relation: Relation) => void;
}) {
  const [relation, setRelation] = useState<Relation>("relates_to");
  const [target, setTarget] = useState("");
  if (candidates.length === 0) {
    return <p className="text-small text-cg-muted">Add a second memory to link them.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <QuietSelect
        aria-label="Relation"
        options={RELATION_ORDER.map((item) => ({ value: item, label: RELATION_LABEL[item] }))}
        value={relation}
        variant="chip"
        onChange={(value) => setRelation(value as Relation)}
      />
      <ArrowRight aria-hidden="true" className="flex-none text-cg-muted" size={13} />
      <QuietSelect
        aria-label="Memory to link to"
        options={candidates.map((item) => ({ value: item.id, label: item.title }))}
        placeholder="Choose a memory"
        searchable
        value={target}
        variant="chip"
        onChange={setTarget}
      />
      <Button
        disabled={busy || target === ""}
        size="sm"
        variant="quiet"
        onClick={() => {
          onLink(target, relation);
          setTarget("");
        }}
      >
        <Link2 aria-hidden="true" size={13} /> Link
      </Button>
    </div>
  );
}

