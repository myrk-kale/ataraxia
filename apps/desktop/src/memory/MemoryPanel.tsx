import { Network, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { SettingRow } from "../app/appearance/AppearanceSettings";
import {
  KIND_LABEL,
  KIND_ORDER,
  isExpired,
  matchesQuery,
  memorySetEnabled,
  type MemoryKind,
} from "../lib/memory";
import { errorText } from "../lib/useInsightEvents";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Toggle } from "../ui/Overlay";
import { QuietSelect } from "../ui/QuietSelect";
import { Loading } from "../ui/State";
import { GLOBAL, MemoryEditor, scopeName, type WorkspaceName } from "./MemoryEditor";
import { KindGlyph } from "./KindGlyph";
import { useMemories } from "./useMemories";

const ALL = "all";

/**
 * Settings > Memory: switch the agents' memory on or off, and read, edit, link and delete what
 * they (and you) have kept. The same memories are drawn as a graph from the header.
 */
export function MemoryPanel({
  workspaces,
  currentWorkspaceId,
  onOpenGraph,
}: {
  workspaces: readonly WorkspaceName[];
  currentWorkspaceId: string | null;
  onOpenGraph: () => void;
}) {
  const { snapshot, state, reload, setSnapshot } = useMemories(true);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string>(ALL);
  const [scope, setScope] = useState(ALL);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const shown = useMemo(
    () =>
      (snapshot?.memories ?? []).filter(
        (memory) =>
          (kind === ALL || memory.kind === kind) &&
          (scope === ALL || (scope === GLOBAL ? memory.workspaceId === null : memory.workspaceId === scope)) &&
          matchesQuery(memory, query),
      ),
    [snapshot, query, kind, scope],
  );

  async function toggle(enabled: boolean) {
    setProblem(null);
    try {
      await memorySetEnabled(enabled);
      setSnapshot((current) => (current ? { ...current, enabled } : current));
    } catch (err) {
      setProblem(errorText(err));
    }
  }

  const total = snapshot?.memories.length ?? 0;

  return (
    <div className="flex flex-col">
      <SettingRow
        hint="Claude Code, Codex and OpenCode share one memory. Before a task they search it, and they save what is worth keeping: your preferences and corrections, decisions and why, causes they verified. Nothing leaves this computer except what the agent you chose reads. It applies to new chats, and to a chat when it restarts."
        title="Agent memory"
      >
        <Toggle
          hideLabel
          isDisabled={!snapshot}
          isSelected={snapshot?.enabled ?? true}
          label="Agents use memory"
          onChange={(enabled) => void toggle(enabled)}
        />
      </SettingRow>

      {problem ? (
        <p className="py-2 text-small text-cg-red" role="alert">
          {problem}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-[10rem] flex-1 items-center gap-1.5 rounded-cg-md border border-cg-control bg-cg-panel px-2 py-1.5">
            <Search aria-hidden="true" className="flex-none text-cg-muted-strong" size={13} />
            <input
              aria-label="Search memories"
              className="min-w-0 flex-1 border-0 bg-transparent text-ui text-cg-ink outline-none placeholder:text-cg-muted"
              placeholder="Search memories"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <QuietSelect
            aria-label="Kind"
            options={[{ value: ALL, label: "All kinds" }, ...KIND_ORDER.map((item) => ({ value: item, label: KIND_LABEL[item] }))]}
            value={kind}
            variant="chip"
            onChange={setKind}
          />
          <QuietSelect
            aria-label="Scope"
            options={[
              { value: ALL, label: "All scopes" },
              { value: GLOBAL, label: "Global" },
              ...workspaces.map((item) => ({ value: item.id as string, label: item.name })),
            ]}
            value={scope}
            variant="chip"
            onChange={setScope}
          />
          <Button variant="quiet" onClick={onOpenGraph}>
            <Network aria-hidden="true" size={13} /> Open the graph
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setOpenId(null);
              setCreating((current) => !current);
            }}
          >
            <Plus aria-hidden="true" size={14} /> New
          </Button>
        </div>

        {creating && snapshot ? (
          <div className="rounded-cg-md border border-cg-line-strong p-3">
            <MemoryEditor
              defaultScope={currentWorkspaceId ?? GLOBAL}
              links={snapshot.links}
              memories={snapshot.memories}
              memory={null}
              workspaces={workspaces}
              onChanged={(select) => {
                void reload();
                setCreating(false);
                setOpenId(select ?? null);
              }}
              onClose={() => setCreating(false)}
              onError={setProblem}
              onSelect={setOpenId}
            />
          </div>
        ) : null}

        {state.kind === "loading" && !snapshot ? <Loading text="Opening what is remembered…" /> : null}
        {state.kind === "failed" ? (
          <p className="text-ui text-cg-red" role="alert">
            The memories did not open: {state.message}{" "}
            <button className="underline" type="button" onClick={() => void reload()}>
              Try again
            </button>
          </p>
        ) : null}
        {snapshot && total === 0 && !creating ? (
          <p className="py-4 text-ui text-cg-muted">
            Nothing is remembered yet. Agents add memories as they work, and you can add one with New.
          </p>
        ) : null}
        {snapshot && total > 0 && shown.length === 0 ? <p className="py-4 text-ui text-cg-muted">No memory matches.</p> : null}

        <ul className="flex flex-col gap-1.5">
          {snapshot
            ? shown.map((memory) => {
                const open = openId === memory.id;
                return (
                  <li key={memory.id} className="rounded-cg-md border border-cg-line bg-cg-panel">
                    <button
                      aria-expanded={open}
                      className="flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-cg-tint"
                      type="button"
                      onClick={() => setOpenId(open ? null : memory.id)}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-ui font-medium text-cg-ink">{memory.title}</span>
                        <Chip icon={<KindGlyph kind={memory.kind as MemoryKind} size={11} />}>{KIND_LABEL[memory.kind]}</Chip>
                        <Chip>{scopeName(memory, workspaces)}</Chip>
                        {isExpired(memory) ? <Chip tone="attention">Expired</Chip> : null}
                      </span>
                      {open ? null : <span className="line-clamp-2 text-small leading-5 text-cg-muted-strong">{memory.body}</span>}
                    </button>
                    {open ? (
                      <div className="border-t border-cg-line p-3">
                        <MemoryEditor
                          defaultScope={currentWorkspaceId ?? GLOBAL}
                          links={snapshot.links}
                          memories={snapshot.memories}
                          memory={memory}
                          workspaces={workspaces}
                          onChanged={(select) => {
                            void reload();
                            setOpenId(select ?? null);
                          }}
                          onClose={() => setOpenId(null)}
                          onError={setProblem}
                          onSelect={setOpenId}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })
            : null}
        </ul>
      </div>
    </div>
  );
}
