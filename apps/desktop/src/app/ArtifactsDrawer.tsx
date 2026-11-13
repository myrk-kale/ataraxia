import { useCallback, useEffect, useState } from "react";
import {
  artifactRetry,
  artifactsList,
  btwList,
  checkpointsList,
  type Artifact,
  type BtwTask,
  type Checkpoint,
} from "../lib/insights";
import { errorText, useInsightEvents } from "../lib/useInsightEvents";
import type { ChatSession } from "../lib/workspace";
import { describeTarget } from "../code/model";
import { Button } from "../ui/Button";
import { SideDrawer } from "../ui/Overlay";
import { Loading, type LoadState } from "../ui/State";
import { StatusLabel } from "../ui/StatusLabel";
import { DeleteArtifactsDialog } from "./DeleteArtifactsDialog";
import type { SpaceId } from "./spaces";

const KIND_LABEL = {
  decision: "Decisions",
  review_priority: "Review priority",
  flow: "Flow diagram",
} as const;

const KIND_SPACE: Record<Artifact["kind"], SpaceId> = {
  decision: "decisions",
  review_priority: "code",
  flow: "flow",
};

function detail(artifact: Artifact): string {
  if (artifact.kind === "decision" && artifact.status === "ready") {
    return `${String(artifact.content.count ?? 0)} found`;
  }
  if (artifact.kind === "flow") {
    return `v${artifact.version} · ${String(artifact.provenance.presetName ?? "")}`;
  }
  return "";
}

/**
 * Everything derived from this chat, grouped the way it was produced:
 * chat → checkpoint → artifacts, plus the BTW investigations that branched off it.
 */
export function ArtifactsDrawer({
  isOpen,
  session,
  onClose,
  onNavigate,
  onOpenBtw,
  onError,
}: {
  isOpen: boolean;
  session: ChatSession | null;
  onClose: () => void;
  onNavigate: (space: SpaceId) => void;
  onOpenBtw: (task: BtwTask) => void;
  onError: (message: string) => void;
}) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [tasks, setTasks] = useState<BtwTask[]>([]);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [deleting, setDeleting] = useState(false);
  const sessionId = session?.id ?? null;

  const load = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    try {
      const [cps, items, btw] = await Promise.all([checkpointsList(sessionId), artifactsList(sessionId), btwList(sessionId)]);
      setCheckpoints(cps);
      setArtifacts(items);
      setTasks(btw);
      setState({ kind: "ready" });
    } catch (err) {
      setState({ kind: "failed", message: errorText(err) });
    }
  }, [sessionId]);

  useEffect(() => {
    if (isOpen) {
      setState({ kind: "loading" });
      void load();
    }
  }, [isOpen, load]);

  useInsightEvents((event) => {
    if (isOpen && "sessionId" in event && event.sessionId === sessionId) {
      void load();
    } else if (isOpen && event.type === "btw" && event.parentSessionId === sessionId) {
      void load();
    }
  });

  const flowsByCheckpoint = (id: string) => artifacts.filter((item) => item.checkpoint_id === id);

  function body() {
    if (!session) {
      return <p className="text-small leading-5 text-cg-muted-strong">Open a chat to see what was derived from its work.</p>;
    }
    if (state.kind === "loading") {
      return <Loading text="Loading what this chat produced…" />;
    }
    if (state.kind === "failed") {
      return (
        <div className="flex flex-col items-start gap-3" role="alert">
          <p className="text-small leading-5 text-cg-ink">Could not load the artifacts of this chat: {state.message}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setState({ kind: "loading" });
              void load();
            }}
          >
            Try again
          </Button>
        </div>
      );
    }
    if (checkpoints.length === 0 && tasks.length === 0) {
      return (
        <p className="text-small leading-6 text-cg-muted-strong">
          Nothing yet. A checkpoint is recorded each time the agent finishes a turn that changes files, and the review ranking is computed from it. Decisions and diagrams appear when you generate them.
        </p>
      );
    }
    return (
      <>
        <ol className="flex flex-col gap-5">
          {[...checkpoints].reverse().map((checkpoint) => {
            const items = flowsByCheckpoint(checkpoint.id);
            return (
              <li key={checkpoint.id}>
                <div className="flex items-baseline gap-2">
                  <span className="text-ui font-semibold text-cg-ink">Checkpoint #{checkpoint.seq}</span>
                  <span className="text-small text-cg-muted-strong">
                    {describeTarget(checkpoint)} · {checkpoint.files.length} file
                    {checkpoint.files.length === 1 ? "" : "s"}
                  </span>
                </div>
                <ul className="mt-1.5 flex flex-col border-l border-cg-line pl-3">
                  {items.map((artifact) => (
                    <li key={artifact.id} className="flex flex-col gap-0.5 py-1">
                      <div className="flex items-center gap-2">
                        <button
                          className="min-w-0 flex-1 truncate text-left text-small text-cg-ink hover:underline"
                          type="button"
                          onClick={() => {
                            onNavigate(KIND_SPACE[artifact.kind]);
                            onClose();
                          }}
                        >
                          {KIND_LABEL[artifact.kind]}
                          <span className="ml-1.5 text-cg-muted-strong">{detail(artifact)}</span>
                        </button>
                        <StatusLabel status={artifact.status} />
                        {artifact.status === "failed" ? (
                          <Button
                            className="flex-none"
                            variant="quiet"
                            onClick={() =>
                              void artifactRetry(artifact.id)
                                .then(load)
                                .catch((err: unknown) => onError(errorText(err)))
                            }
                          >
                            Retry
                          </Button>
                        ) : null}
                      </div>
                      {artifact.status === "failed" && artifact.error ? (
                        <p className="text-small leading-5 text-cg-muted-strong">{artifact.error}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>

        {tasks.length > 0 ? (
          <section aria-label="BTW questions" className="mt-6">
            <h3 className="text-small font-semibold text-cg-muted-strong">BTW side questions</h3>
            <ul className="mt-2 flex flex-col">
              {tasks.map((task) => (
                <li key={task.id}>
                  <button
                    className="flex w-full items-baseline gap-2 py-1.5 text-left text-small hover:text-cg-ink"
                    type="button"
                    onClick={() => {
                      onOpenBtw(task);
                      onClose();
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate text-cg-ink">{task.question}</span>
                    <span className="flex-none text-cg-muted-strong">{task.mode === "change" ? "change" : "question"}</span>
                    <StatusLabel status={task.status} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </>
    );
  }

  return (
    <SideDrawer isOpen={isOpen} label="Artifacts of this chat" onClose={onClose}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="border-b border-cg-line px-5 pt-5 pb-4">
          <p className="text-small font-semibold text-cg-muted-strong">Artifacts</p>
          <h2 className="mt-1 truncate text-heading font-semibold text-cg-ink">{session?.title ?? "No chat open"}</h2>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{body()}</div>
        {session && state.kind === "ready" && checkpoints.length > 0 ? (
          <footer className="border-t border-cg-line px-5 py-3">
            <button
              className="text-small font-medium text-cg-red hover:underline"
              type="button"
              onClick={() => setDeleting(true)}
            >
              Delete all artifacts…
            </button>
          </footer>
        ) : null}
        {session ? (
          <DeleteArtifactsDialog
            counts={{
              checkpoints: checkpoints.length,
              decisions: artifacts
                .filter((item) => item.kind === "decision")
                .reduce((sum, item) => sum + (typeof item.content.count === "number" ? item.content.count : 0), 0),
              diagrams: artifacts.filter((item) => item.kind === "flow").length,
            }}
            isOpen={deleting}
            sessionId={session.id}
            title={session.title}
            onClose={() => setDeleting(false)}
            onDeleted={() => void load()}
          />
        ) : null}
      </div>
    </SideDrawer>
  );
}
