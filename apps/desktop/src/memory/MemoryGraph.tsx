import {
  BaseEdge,
  EdgeLabelRenderer,
  getStraightPath,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { Plus, Search } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useAppearance } from "../app/appearance/store";
import {
  KIND_LABEL,
  KIND_ORDER,
  RELATION_LABEL,
  isExpired,
  isSymmetric,
  matchesQuery,
  type Memory,
  type MemoryKind,
  type MemoryLink,
  type Relation,
} from "../lib/memory";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Overlay";
import { QuietSelect } from "../ui/QuietSelect";
import { StateMessage } from "../ui/State";
import { GLOBAL, MemoryEditor, scopeName, type WorkspaceName } from "./MemoryEditor";
import { KindGlyph } from "./KindGlyph";
import { layoutForce } from "./layout";
import { useMemories } from "./useMemories";

type NodeData = { memory: Memory; scope: string; dimmed: boolean; expired: boolean };
type MemoryNode = Node<NodeData, "memory">;
/** `lane` of `lanes`: links between the same two memories are drawn side by side, not on top of each other. */
type EdgeData = { relation: Relation; dimmed: boolean; lane: number; lanes: number };
type MemoryEdge = Edge<EdgeData, "relation">;

const NODE_WIDTH = 208;

const MemoryNodeView = memo(function MemoryNodeView({ data, selected }: NodeProps<MemoryNode>) {
  const { memory, scope, dimmed, expired } = data;
  return (
    <div
      className={`w-[13rem] rounded-cg-md border bg-cg-panel px-3 py-2 text-left shadow-cg-lift transition-opacity ${
        selected ? "border-cg-accent" : "border-cg-control"
      } ${dimmed ? "opacity-35" : ""} ${expired ? "border-dashed" : ""}`}
    >
      {/* The edges are drawn from the node's edge, not from a handle: these only exist for the library. */}
      <Handle isConnectable={false} position={Position.Top} style={{ opacity: 0 }} type="target" />
      <div className="flex items-center gap-1.5 text-small font-semibold text-cg-muted-strong">
        <KindGlyph kind={memory.kind} />
        {KIND_LABEL[memory.kind]}
        <span className="ml-auto max-w-[6rem] truncate font-normal text-cg-muted" title={scope}>
          {scope}
        </span>
      </div>
      <div className="mt-1 line-clamp-3 text-ui leading-snug font-medium text-cg-ink">{memory.title}</div>
      {expired ? <div className="mt-1 text-small text-cg-amber-text">Expired</div> : null}
      <Handle isConnectable={false} position={Position.Bottom} style={{ opacity: 0 }} type="source" />
    </div>
  );
});

/** Where the line from `node` toward `target` leaves the node's box. */
function edgePoint(node: InternalNode, target: InternalNode): { x: number; y: number } {
  const width = node.measured.width ?? NODE_WIDTH;
  const height = node.measured.height ?? 70;
  const half = { w: width / 2, h: height / 2 };
  const center = { x: node.internals.positionAbsolute.x + half.w, y: node.internals.positionAbsolute.y + half.h };
  const other = {
    x: target.internals.positionAbsolute.x + (target.measured.width ?? NODE_WIDTH) / 2,
    y: target.internals.positionAbsolute.y + (target.measured.height ?? 70) / 2,
  };
  const dx = other.x - center.x;
  const dy = other.y - center.y;
  if (dx === 0 && dy === 0) {
    return center;
  }
  // The box is crossed on the side whose ratio is larger.
  const scale = 1 / Math.max(Math.abs(dx) / half.w, Math.abs(dy) / half.h);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

const RelationEdgeView = memo(function RelationEdgeView({ id, source, target, data, markerEnd }: EdgeProps<MemoryEdge>) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to || !data) {
    return null;
  }
  let start = edgePoint(from, to);
  let end = edgePoint(to, from);
  // Each lane is a step to the side of the straight line between the two boxes.
  const side = (data.lane - (data.lanes - 1) / 2) * 26;
  if (side !== 0) {
    const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
    const shift = { x: (-(end.y - start.y) / length) * side, y: ((end.x - start.x) / length) * side };
    start = { x: start.x + shift.x, y: start.y + shift.y };
    end = { x: end.x + shift.x, y: end.y + shift.y };
  }
  const [path, labelX, labelY] = getStraightPath({ sourceX: start.x, sourceY: start.y, targetX: end.x, targetY: end.y });
  // A conflict needs somebody's attention (amber, dashed); a replaced memory fades (dotted).
  const style =
    data.relation === "contradicts"
      ? { stroke: "var(--cg-amber)", strokeWidth: 1.8, strokeDasharray: "7 4" }
      : data.relation === "supersedes"
        ? { stroke: "var(--cg-control)", strokeWidth: 1.4, strokeDasharray: "2 4" }
        : { stroke: "var(--cg-control)", strokeWidth: 1.4 };
  return (
    <g opacity={data.dimmed ? 0.25 : 1}>
      <BaseEdge id={id} markerEnd={markerEnd} path={path} style={style} />
      <EdgeLabelRenderer>
        <span
          className="nodrag nopan pointer-events-none absolute rounded-cg-sm bg-cg-panel px-1 text-small text-cg-muted-strong"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {RELATION_LABEL[data.relation]}
        </span>
      </EdgeLabelRenderer>
    </g>
  );
});

const nodeTypes = { memory: MemoryNodeView };
const edgeTypes = { relation: RelationEdgeView };

const ALL = "all";

/**
 * Everything the agents remember, drawn as a graph: a node for each memory (the shape says what
 * kind it is), a line for each link (its words say how the two relate). Click a node to read, edit,
 * link or delete it; the agents' changes appear as they are made.
 */
export function MemoryGraph({
  isOpen,
  workspaces,
  currentWorkspaceId,
  onClose,
  onError,
}: {
  isOpen: boolean;
  workspaces: readonly WorkspaceName[];
  currentWorkspaceId: string | null;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const { snapshot, state, reload } = useMemories(isOpen);
  const { kind: theme } = useAppearance();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<ReadonlySet<MemoryKind>>(new Set(KIND_ORDER));
  const [scope, setScope] = useState(ALL);
  const [showExpired, setShowExpired] = useState(false);

  const memories = snapshot?.memories;
  const links = snapshot?.links;

  const visible = useMemo(
    () =>
      (memories ?? []).filter(
        (memory) =>
          kinds.has(memory.kind) &&
          (showExpired || !isExpired(memory)) &&
          (scope === ALL || (scope === GLOBAL ? memory.workspaceId === null : memory.workspaceId === scope)),
      ),
    [memories, kinds, showExpired, scope],
  );
  const visibleLinks = useMemo(() => {
    const ids = new Set(visible.map((memory) => memory.id));
    return (links ?? []).filter((link) => ids.has(link.fromId) && ids.has(link.toId));
  }, [visible, links]);

  // The layout depends on what is drawn, not on what is typed in the search box.
  const placed = useMemo(
    () =>
      layoutForce(
        visible.map((memory) => memory.id),
        visibleLinks.map((link) => ({ source: link.fromId, target: link.toId })),
      ),
    [visible, visibleLinks],
  );

  // Where the reader dragged a node to: it stays there while the rest of the graph reloads.
  const [moved, setMoved] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map());
  const onNodesChange = useCallback((changes: NodeChange<MemoryNode>[]) => {
    setMoved((current) => {
      let next = current;
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          if (next === current) {
            next = new Map(current);
          }
          (next as Map<string, { x: number; y: number }>).set(change.id, change.position);
        }
      }
      return next;
    });
  }, []);

  const searching = query.trim() !== "";
  const matching = useMemo(
    () => new Set(visible.filter((memory) => matchesQuery(memory, query)).map((memory) => memory.id)),
    [visible, query],
  );

  const nodes = useMemo<MemoryNode[]>(
    () =>
      visible.map((memory) => ({
        id: memory.id,
        type: "memory",
        position: moved.get(memory.id) ?? placed.get(memory.id) ?? { x: 0, y: 0 },
        selected: memory.id === selectedId,
        data: {
          memory,
          scope: scopeName(memory, workspaces),
          dimmed: searching && !matching.has(memory.id),
          expired: isExpired(memory),
        },
      })),
    [visible, placed, moved, selectedId, workspaces, searching, matching],
  );
  const edges = useMemo<MemoryEdge[]>(() => {
    const pair = (link: MemoryLink) => [link.fromId, link.toId].sort().join("|");
    const lanes = new Map<string, number>();
    for (const link of visibleLinks) {
      lanes.set(pair(link), (lanes.get(pair(link)) ?? 0) + 1);
    }
    const used = new Map<string, number>();
    return visibleLinks.map((link) => {
      const key = pair(link);
      const lane = used.get(key) ?? 0;
      used.set(key, lane + 1);
      return {
        id: `${link.fromId}>${link.toId}:${link.relation}`,
        type: "relation" as const,
        source: link.fromId,
        target: link.toId,
        markerEnd: isSymmetric(link.relation) ? undefined : { type: "arrowclosed" as const, color: "var(--cg-control)" },
        data: {
          relation: link.relation,
          dimmed: searching && !(matching.has(link.fromId) && matching.has(link.toId)),
          lane,
          lanes: lanes.get(key) ?? 1,
        },
      };
    });
  }, [visibleLinks, searching, matching]);

  const selected = useMemo(() => (memories ?? []).find((memory) => memory.id === selectedId) ?? null, [memories, selectedId]);
  useEffect(() => {
    if (selectedId !== null && memories && !selected) {
      setSelectedId(null);
    }
  }, [memories, selected, selectedId]);
  useEffect(() => {
    if (!isOpen) {
      setSelectedId(null);
      setCreating(false);
    }
  }, [isOpen]);

  const toggleKind = useCallback((kind: MemoryKind) => {
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind) && next.size > 1) {
        next.delete(kind);
      } else {
        next.add(kind);
      }
      return next;
    });
  }, []);

  const defaultScope = currentWorkspaceId ?? GLOBAL;
  const panelOpen = creating || selected !== null;
  const total = memories?.length ?? 0;
  const conflicts = (links ?? []).filter((link) => link.relation === "contradicts").length;

  return (
    <Dialog
      className="h-[min(86vh,860px)] w-[min(1320px,96vw)] max-w-none gap-0 p-0"
      isOpen={isOpen}
      label="Memory graph"
      size="lg"
      onClose={onClose}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-cg-line px-5 py-3">
          <div className="mr-auto flex min-w-0 flex-col">
            <h2 className="text-heading font-semibold text-cg-ink">Memory</h2>
            <p className="text-small text-cg-muted-strong">
              {total} {total === 1 ? "memory" : "memories"}
              {conflicts > 0 ? ` · ${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"} to settle` : ""}
              {snapshot && !snapshot.enabled ? " · switched off in Settings" : ""}
            </p>
          </div>
          <label className="flex items-center gap-1.5 rounded-cg-md border border-cg-control bg-cg-panel px-2 py-1">
            <Search aria-hidden="true" className="flex-none text-cg-muted-strong" size={13} />
            <input
              aria-label="Find in the graph"
              className="w-40 border-0 bg-transparent text-ui text-cg-ink outline-none placeholder:text-cg-muted"
              placeholder="Find a memory"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div aria-label="Kinds shown" className="flex items-center gap-1" role="group">
            {KIND_ORDER.map((kind) => (
              <Button
                key={kind}
                aria-pressed={kinds.has(kind)}
                size="sm"
                variant="quiet"
                onClick={() => toggleKind(kind)}
              >
                <KindGlyph kind={kind} size={12} />
                {KIND_LABEL[kind]}
              </Button>
            ))}
          </div>
          <QuietSelect
            aria-label="Scope shown"
            options={[
              { value: ALL, label: "All scopes" },
              { value: GLOBAL, label: "Global only" },
              ...workspaces.map((item) => ({ value: item.id as string, label: item.name })),
            ]}
            value={scope}
            variant="chip"
            onChange={setScope}
          />
          <Button aria-pressed={showExpired} size="sm" variant="quiet" onClick={() => setShowExpired((current) => !current)}>
            Expired
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setSelectedId(null);
              setCreating(true);
            }}
          >
            <Plus aria-hidden="true" size={14} /> New
          </Button>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1">
            {state.kind === "loading" && !snapshot ? <StateMessage text="Opening what is remembered…" tone="loading" /> : null}
            {state.kind === "failed" ? (
              <StateMessage text={`The memories did not open: ${state.message}`} tone="failed">
                <Button onClick={() => void reload()}>Try again</Button>
              </StateMessage>
            ) : null}
            {snapshot && total === 0 ? (
              <StateMessage
                text="Nothing is remembered yet."
                title="Memory"
              >
                <p className="max-w-[420px] text-ui leading-6 text-cg-muted-strong">
                  Agents save what is worth keeping as they work (your preferences, decisions and why, causes they verified). You can
                  also add one yourself.
                </p>
                <Button
                  onClick={() => {
                    setCreating(true);
                  }}
                >
                  Add a memory
                </Button>
              </StateMessage>
            ) : null}
            {snapshot && total > 0 && visible.length === 0 ? (
              <StateMessage text="No memory matches these filters." title="Memory" />
            ) : null}
            {visible.length > 0 ? (
              <ReactFlowProvider>
                <ReactFlow<MemoryNode, MemoryEdge>
                  key={`${visible.length}-${visibleLinks.length}-${scope}`}
                  attributionPosition="bottom-left"
                  colorMode={theme}
                  edges={edges}
                  edgeTypes={edgeTypes}
                  fitView
                  fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
                  minZoom={0.15}
                  nodes={nodes}
                  nodesConnectable={false}
                  nodesDraggable
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onNodeClick={(_, clicked) => {
                    setCreating(false);
                    setSelectedId(clicked.id);
                  }}
                  onPaneClick={() => setSelectedId(null)}
                />
              </ReactFlowProvider>
            ) : null}
          </div>

          {panelOpen && snapshot ? (
            <aside aria-label="Memory details" className="min-h-0 w-[min(24rem,42%)] flex-none overflow-y-auto border-l border-cg-line p-4">
              <MemoryEditor
                defaultScope={defaultScope}
                links={snapshot.links}
                memories={snapshot.memories}
                memory={creating ? null : selected}
                workspaces={workspaces}
                onChanged={(select) => {
                  void reload();
                  setCreating(false);
                  setSelectedId(select ?? null);
                }}
                onClose={() => {
                  setCreating(false);
                  setSelectedId(null);
                }}
                onError={onError}
                onSelect={(id) => {
                  setCreating(false);
                  setSelectedId(id);
                }}
              />
            </aside>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
