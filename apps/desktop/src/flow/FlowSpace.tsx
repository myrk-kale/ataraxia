import { TextArea } from "@heroui/react";
import { Handle, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useAppearance } from "../app/appearance/store";
import type { SpaceBridge } from "../app/spaceCommands";
import {
  artifactRetry,
  flowDeletePreset,
  flowGenerate,
  flowList,
  flowPresets,
  flowSavePreset,
  type Artifact,
  type FlowContent,
  type FlowNodeData,
  type FlowPreset,
} from "../lib/insights";
import { errorText, useInsightEvents } from "../lib/useInsightEvents";
import type { ChatSession } from "../lib/workspace";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { QuietSelect } from "../ui/QuietSelect";
import { Dialog, Tip } from "../ui/Overlay";
import { LOADING, READY, StateMessage, type LoadState } from "../ui/State";
import { flowDirection, layoutGraph } from "./layout";

type NodeUi = { data: FlowNodeData };

// The kind is always written out on the node; only the entry point, where a reader starts, gets the accent.
const KIND_ACCENT: Record<string, string> = {
  entry: "var(--cg-accent)",
};

const CodeNode = memo(function CodeNode({ data, selected, sourcePosition, targetPosition }: NodeProps<Node<NodeUi["data"]>>) {
  return (
    <div
      className={`w-[15rem] rounded-cg-md border bg-cg-panel px-3 py-2.5 text-left shadow-cg-lift transition-colors ${
        selected ? "border-cg-ink" : "border-cg-control"
      }`}
    >
      <Handle isConnectable={false} position={targetPosition ?? Position.Left} style={{ opacity: 0 }} type="target" />
      <div className="flex items-center gap-1.5 text-small font-semibold text-cg-muted">
        <span
          aria-hidden="true"
          className="h-[6px] w-[6px] rounded-full"
          style={{ background: KIND_ACCENT[data.kind] ?? "var(--cg-control)" }}
        />
        {data.kind}
        {data.verified ? (
          <span className="ml-auto text-cg-green" title="Backed by code in this repository">
            ✓ code
          </span>
        ) : (
          <span className="ml-auto font-normal text-cg-muted" title="No verified code reference">
            no ref
          </span>
        )}
      </div>
      <div className="mt-1 text-ui leading-snug font-medium text-cg-ink">{data.label}</div>
      <Handle isConnectable={false} position={sourcePosition ?? Position.Right} style={{ opacity: 0 }} type="source" />
    </div>
  );
});

const nodeTypes = { code: CodeNode };

function stamp(artifact: Artifact): string {
  const name = String(artifact.provenance.presetName ?? "Diagram");
  const suffix = artifact.status === "ready" ? "" : ` · ${artifact.status}`;
  return `v${artifact.version} · ${name}${suffix}`;
}

/** The open diagram in words: what it says and the steps in it, so BTW can answer about it. */
function flowBrief(content: FlowContent): string {
  const nodes = content.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node.label]));
  const lines = [content.summary ?? ""];
  for (const node of nodes.slice(0, 40)) {
    const where = node.refs[0] ? ` (${node.refs[0].path}${node.refs[0].start_line ? `:${node.refs[0].start_line}` : ""})` : "";
    lines.push(`- ${node.kind}: ${node.label}${where}`);
  }
  for (const edge of (content.edges ?? []).slice(0, 60)) {
    lines.push(`${byId.get(edge.source) ?? edge.source} -> ${byId.get(edge.target) ?? edge.target}${edge.label ? ` (${edge.label})` : ""}`);
  }
  return lines.filter(Boolean).join("\n");
}

export function FlowSpace({
  session,
  bridge,
  onOpenFile,
  onError,
}: {
  session: ChatSession | null;
  bridge: MutableRefObject<SpaceBridge>;
  onOpenFile: (path: string, line: number | null) => void;
  onError: (message: string) => void;
}) {
  const { kind } = useAppearance();
  const [presets, setPresets] = useState<FlowPreset[]>([]);
  const [presetId, setPresetId] = useState<string>("");
  const [extra, setExtra] = useState("");
  const [flows, setFlows] = useState<Artifact[]>([]);
  const [flowsState, setFlowsState] = useState<LoadState>(LOADING);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ preset: FlowPreset | null } | null>(null);
  const sessionId = session?.id ?? null;
  const repositoryId = session?.repository_id ?? null;

  const loadFlows = useCallback(async (): Promise<Artifact[] | null> => {
    if (!sessionId) {
      setFlows([]);
      setFlowsState(READY);
      return null;
    }
    try {
      const list = await flowList(sessionId);
      setFlows(list);
      setFlowsState(READY);
      return list;
    } catch (err) {
      setFlowsState({ kind: "failed", message: errorText(err) });
      return null;
    }
  }, [sessionId]);

  const loadPresets = useCallback(async () => {
    if (!repositoryId) {
      return;
    }
    try {
      const list = await flowPresets(repositoryId);
      setPresets(list);
      setPresetId((current) => (list.some((item) => item.id === current) ? current : (list[0]?.id ?? "")));
    } catch (err) {
      onError(errorText(err));
    }
  }, [repositoryId, onError]);

  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  useEffect(() => {
    setFlowId(null);
    setFlowsState(LOADING);
    void loadFlows();
  }, [loadFlows]);

  const knownFlows = useRef(flows);
  knownFlows.current = flows;

  useInsightEvents((event) => {
    if (
      ((event.type === "artifact" && event.kind === "flow") || event.type === "cleared") &&
      event.sessionId === sessionId
    ) {
      // A diagram that was not there before (the agent drew one, or Generate started one) is the one
      // to show; an update to a diagram already listed leaves the choice where it is.
      const added =
        event.type === "artifact" && !knownFlows.current.some((item) => item.id === event.artifactId)
          ? event.artifactId
          : null;
      void loadFlows().then((list) => {
        if (added && list?.some((item) => item.id === added)) {
          setFlowId(added);
        }
      });
    }
  });

  useEffect(() => {
    if (!flowId || !flows.some((item) => item.id === flowId)) {
      setFlowId(flows[0]?.id ?? null);
    }
  }, [flows, flowId]);

  const flow = flows.find((item) => item.id === flowId) ?? null;
  const content = (flow?.content ?? {}) as FlowContent;
  const dataNodes = content.nodes ?? [];

  const { nodes, edges } = useMemo(() => {
    const ids = dataNodes.map((node) => node.id);
    const across = layoutGraph(ids, content.edges ?? []);
    const layers = Math.max(0, ...[...across.values()].map((spot) => spot.layer)) + 1;
    const direction = flowDirection(layers, window.innerWidth - 160);
    const placed = direction === "down" ? layoutGraph(ids, content.edges ?? [], "down") : across;
    const nodes: Node<FlowNodeData>[] = dataNodes.map((node) => ({
      id: node.id,
      type: "code",
      sourcePosition: direction === "down" ? Position.Bottom : Position.Right,
      targetPosition: direction === "down" ? Position.Top : Position.Left,
      position: { x: placed.get(node.id)?.x ?? 0, y: placed.get(node.id)?.y ?? 0 },
      data: node,
      selected: node.id === selectedNode,
    }));
    const edges: Edge[] = (content.edges ?? []).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label || undefined,
      type: "smoothstep",
      style: { stroke: "var(--cg-control)", strokeWidth: 1.4 },
      labelStyle: { fill: "var(--cg-muted-strong)", fontSize: 11 },
      labelBgStyle: { fill: "var(--cg-panel)" },
    }));
    return { nodes, edges };
  }, [dataNodes, content.edges, selectedNode]);

  const node = dataNodes.find((item) => item.id === selectedNode) ?? null;

  useEffect(() => {
    setSelectedNode(null);
  }, [flowId]);

  useEffect(() => {
    bridge.current.context = node
      ? {
          kind: "flow-node",
          label: `Flow node: ${node.label}`,
          path: node.refs[0]?.path,
          startLine: node.refs[0]?.start_line ?? undefined,
          endLine: node.refs[0]?.end_line ?? undefined,
          text: `${node.kind}: ${node.label}\n${node.description}`,
        }
      : flow
        ? {
            kind: "flow",
            label: `Flow diagram: ${String(flow.provenance.presetName ?? "")}`,
            text: flowBrief(content),
          }
        : null;
    return () => {
      bridge.current.context = null;
    };
  }, [bridge, node, flow]);

  async function generate() {
    if (!sessionId || !presetId) {
      return;
    }
    try {
      const created = await flowGenerate(sessionId, presetId, extra);
      setFlows((list) => [created, ...list.filter((item) => item.id !== created.id)]);
      setFlowId(created.id);
    } catch (err) {
      onError(errorText(err));
    }
  }

  const preset = presets.find((item) => item.id === presetId) ?? null;
  const working = flow?.status === "queued" || flow?.status === "running";

  if (!session) {
    return (
      <StateMessage text="Open or start a chat to draw diagrams of its code." title="Flow" />
    );
  }

  return (
    <div className="relative h-full min-h-0">
      {flow && flow.status !== "failed" && dataNodes.length > 0 ? (
        <ReactFlowProvider>
          <ReactFlow
            colorMode={kind}
            attributionPosition="bottom-center"
            edges={edges}
            fitView
            fitViewOptions={{ padding: { top: "140px", right: "60px", bottom: "70px", left: "60px" }, maxZoom: 1 }}
            minZoom={0.2}
            nodes={nodes}
            nodesConnectable={false}
            nodesDraggable
            nodeTypes={nodeTypes}
            onNodeClick={(_, clicked) => setSelectedNode(clicked.id)}
            onPaneClick={() => setSelectedNode(null)}
          />
        </ReactFlowProvider>
      ) : (
        <div className="flex h-full items-center justify-center px-8 text-center">
          <div className="flex max-w-[420px] flex-col items-center gap-3">
            {flowsState.kind === "loading" ? (
              <p aria-live="polite" className="flex items-center gap-2 text-ui text-cg-muted-strong" role="status">
                <Loader2 aria-hidden="true" className="animate-spin" size={15} /> Loading the diagrams of this chat…
              </p>
            ) : flowsState.kind === "failed" ? (
              <>
                <p className="text-ui leading-6 text-cg-ink" role="alert">
                  Could not load the diagrams: {flowsState.message}
                </p>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFlowsState(LOADING);
                    void loadFlows();
                  }}
                >
                  Try again
                </Button>
              </>
            ) : working ? (
              <p aria-live="polite" className="flex items-center gap-2 text-ui text-cg-muted-strong">
                <Loader2 aria-hidden="true" className="animate-spin" size={15} /> Drawing the diagram from the code…
              </p>
            ) : flow?.status === "failed" ? (
              <>
                <p className="text-ui leading-6 text-cg-muted-strong">The diagram could not be generated: {flow.error}</p>
                <Button
                  variant="secondary"
                  onClick={() => void artifactRetry(flow.id).then(loadFlows).catch((err: unknown) => onError(errorText(err)))}
                >
                  Retry
                </Button>
              </>
            ) : (
              <p className="text-ui leading-6 text-cg-muted">
                Pick a preset and press Generate. Nothing is drawn until you ask.
              </p>
            )}
          </div>
        </div>
      )}

      <div
        aria-label="Generate a diagram"
        className="absolute top-4 left-1/2 z-10 flex w-[min(760px,calc(100%-32px))] -translate-x-1/2 items-center gap-1.5 rounded-cg-lg border border-cg-line bg-cg-float px-2.5 py-2 shadow-cg-lift"
        role="group"
      >
        <QuietSelect
          aria-label="Prompt preset"
          className="max-w-[190px] flex-none text-small font-medium text-cg-ink"
          options={presets.map((item) => ({ value: item.id, label: item.name }))}
          value={presetId}
          onChange={setPresetId}
        />
        <Tip label="New preset">
          <Button aria-label="Add preset" variant="icon" onClick={() => setEditing({ preset: null })}>
            <Plus size={15} />
          </Button>
        </Tip>
        <Tip label="Edit preset">
          <Button
            aria-label="Edit preset"
            disabled={!preset}
            variant="icon"
            onClick={() => preset && setEditing({ preset })}
          >
            <Pencil size={14} />
          </Button>
        </Tip>
        <input
          aria-label="Additional instructions for this run"
          className="min-w-0 flex-1 border-0 bg-transparent px-2 text-small text-cg-ink outline-none placeholder:text-cg-muted"
          placeholder="Additional instructions for this run (optional)"
          value={extra}
          onChange={(event) => setExtra(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              void generate();
            }
          }}
        />
        <Button className="flex-none" size="sm" disabled={!presetId || working} variant="primary" onClick={() => void generate()}>
          Generate
        </Button>
      </div>

      {flows.length > 0 ? (
        <div className="absolute top-[72px] left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 text-small text-cg-muted">
          <QuietSelect
            aria-label="Generated diagrams"
            className="max-w-[300px] text-small text-cg-muted-strong"
            options={flows.map((item) => ({ value: item.id, label: stamp(item) }))}
            value={flowId ?? ""}
            onChange={setFlowId}
          />
          {flow?.status === "stale" ? (
            <Chip tone="attention">Out of date: the code changed since this was drawn</Chip>
          ) : null}
        </div>
      ) : null}

      {node ? (
        <aside
          aria-label="Selected node"
          className="absolute right-[52px] bottom-5 z-10 flex w-[24rem] max-w-[calc(100%-96px)] min-w-0 flex-col gap-2 overflow-hidden rounded-cg-lg border border-cg-line bg-cg-panel p-4 shadow-cg-float"
        >
          <p className="text-small font-semibold text-cg-muted">{node.kind}</p>
          <h2 className="text-heading font-semibold text-cg-ink">{node.label}</h2>
          {node.description ? <p className="text-small leading-5 text-cg-muted-strong">{node.description}</p> : null}
          {node.refs.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {node.refs.map((ref) => (
                <li key={`${ref.path}:${ref.start_line}`}>
                  <button
                    className="max-w-full text-left font-mono text-small leading-5 break-all text-cg-accent hover:underline"
                    type="button"
                    onClick={() => onOpenFile(ref.path, ref.start_line)}
                  >
                    {ref.path}
                    {ref.start_line ? `:${ref.start_line}` : ""}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-small text-cg-muted">No verified code reference for this node.</p>
          )}
        </aside>
      ) : null}

      {flow && content.summary ? (
        <p className="absolute bottom-3 left-4 z-10 max-h-24 max-w-[min(520px,50%)] overflow-y-auto rounded-cg-md border border-cg-line bg-cg-panel px-3 py-2 text-small leading-5 text-cg-muted-strong">
          {content.summary ?? ""}
        </p>
      ) : null}

      <PresetDialog
        editing={editing}
        onClose={() => setEditing(null)}
        onDelete={async (target) => {
          try {
            await flowDeletePreset(target.id);
            await loadPresets();
          } catch (err) {
            onError(errorText(err));
          }
        }}
        onSave={async (target, name, prompt) => {
          try {
            const saved = await flowSavePreset(target?.id ?? null, repositoryId, name, prompt);
            await loadPresets();
            setPresetId(saved.id);
          } catch (err) {
            onError(errorText(err));
            throw err;
          }
        }}
      />
    </div>
  );
}

function PresetDialog({
  editing,
  onClose,
  onSave,
  onDelete,
}: {
  editing: { preset: FlowPreset | null } | null;
  onClose: () => void;
  onSave: (preset: FlowPreset | null, name: string, prompt: string) => Promise<void>;
  onDelete: (preset: FlowPreset) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const target = editing?.preset ?? null;

  useEffect(() => {
    if (editing) {
      setName(target?.name ?? "");
      setPrompt(target?.prompt ?? "");
    }
  }, [editing, target]);

  return (
    <Dialog isOpen={editing !== null} label={target ? "Edit preset" : "New preset"} size="md" onClose={onClose}>
      <form
        className="flex flex-col gap-3 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(target, name, prompt).then(onClose, () => undefined);
        }}
      >
        <h2 className="text-heading font-semibold text-cg-ink">{target ? "Edit preset" : "New preset"}</h2>
        <input
          aria-label="Preset name"
          autoFocus
          className="rounded-cg-md border border-cg-control bg-cg-panel px-3 py-2 text-ui text-cg-ink focus:border-cg-ink"
          placeholder="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextArea
          aria-label="Preset prompt"
          className="min-h-[140px] w-full text-ui"
          fullWidth
          placeholder="What should the diagram show?"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        {target ? (
          <p className="text-small text-cg-muted">Version {target.version}. Saving a change creates the next version; saving never generates a diagram.</p>
        ) : null}
        <div className="flex items-center justify-between">
          {target && !target.builtin ? (
            <Button
              variant="quiet"
              onClick={() => void onDelete(target).then(onClose)}
            >
              <span className="inline-flex items-center gap-1.5 text-cg-red"><Trash2 aria-hidden="true" size={13} />Delete preset</span>
            </Button>
          ) : (
            <span />
          )}
          <Button disabled={!name.trim() || !prompt.trim()} type="submit" variant="primary">
            Save preset
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
