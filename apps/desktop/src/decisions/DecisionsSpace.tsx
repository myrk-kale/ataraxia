import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { SpaceBridge } from "../app/spaceCommands";
import {
  artifactRetry,
  artifactsList,
  decisionDetail,
  decisionComment,
  decisionPostMessage,
  decisionRequestChange,
  decisionSetState,
  decisionUnlinkCommit,
  decisionsList,
  type Artifact,
  type Decision,
  type DecisionDetail,
  type DecisionState,
} from "../lib/insights";
import { errorText, useInsightEvents } from "../lib/useInsightEvents";
import type { ChatSession } from "../lib/workspace";
import { CommentComposer } from "../code/CommentComposer";
import { stepIn } from "../code/model";
import { Button } from "../ui/Button";
import { LOADING, READY, StateMessage, type LoadState } from "../ui/State";
import { DecisionIssue } from "./DecisionIssue";
import { ThreadDialog } from "./ThreadDialog";
import { DecisionList } from "./DecisionList";
import { GenerateDialog, LinkCommitDialog, NewDecisionDialog } from "./Dialogs";
import { filterDecisions, generationState, KIND_LABEL, orderDecisions, refLabel, type Tab } from "./model";

/**
 * Decisions as threads, like the issues of a repository: a list, and one page per decision with
 * its description, its discussion and the commits that influence it. A thread stays where it is
 * while the code changes. Nothing here is generated until the reviewer asks.
 */
/** Everything about a decision that BTW needs to answer about it or to comment on it. */
function decisionBrief(decision: Decision): string {
  const lines = [`${KIND_LABEL[decision.kind]} decision #${decision.seq} (${decision.state}): ${decision.title}`, decision.summary];
  if (decision.context) {
    lines.push(`Context: ${decision.context}`);
  }
  if (decision.rationale) {
    lines.push(`Why this option: ${decision.rationale}`);
  }
  for (const alternative of decision.alternatives) {
    lines.push(`Alternative: ${alternative.title}${alternative.note ? `: ${alternative.note}` : ""}`);
  }
  for (const ref of decision.refs) {
    lines.push(`Code: ${refLabel(ref)}`);
  }
  return lines.join("\n");
}

export function DecisionsSpace({
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
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DecisionDetail | null>(null);
  const [tab, setTab] = useState<Tab>("open");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState("");
  const [threadOpen, setThreadOpen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState(false);
  const [loaded, setLoaded] = useState<LoadState>(LOADING);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const sessionId = session?.id ?? null;

  const ids = useMemo(() => orderDecisions(decisions).map((item) => item.id), [decisions]);
  const shown = useMemo(() => filterDecisions(decisions, tab, query), [decisions, tab, query]);
  const current = decisions.find((item) => item.id === selected) ?? null;
  const generation = useMemo(() => generationState(artifacts), [artifacts]);

  const load = useCallback(async () => {
    if (!sessionId) {
      setDecisions([]);
      setArtifacts([]);
      setLoaded(READY);
      return;
    }
    try {
      const [list, items] = await Promise.all([decisionsList(sessionId), artifactsList(sessionId)]);
      setDecisions(list);
      setArtifacts(items);
      setLoaded(READY);
    } catch (err) {
      setLoaded({ kind: "failed", message: errorText(err) });
    }
  }, [sessionId]);

  useEffect(() => {
    setSelected(null);
    setDetail(null);
    setTab("open");
    setQuery("");
    setLoaded(LOADING);
    void load();
  }, [load]);

  // A thread that disappeared (its chat was reset) sends the reader back to the list.
  useEffect(() => {
    if (selected && loaded.kind === "ready" && !ids.includes(selected)) {
      setSelected(null);
    }
  }, [ids, selected, loaded]);

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        setDetail(await decisionDetail(id));
      } catch (err) {
        onError(errorText(err));
      }
    },
    [onError],
  );

  useEffect(() => {
    setDetail(null);
    setWaiting(false);
    setDraft("");
    setAsking("");
    setThreadOpen(false);
    if (selected) {
      void loadDetail(selected);
    }
  }, [selected, loadDetail]);

  useInsightEvents((event) => {
    if (event.type === "decisions" || event.type === "artifact" || event.type === "cleared") {
      if (event.sessionId === sessionId) {
        void load();
      }
    } else if (event.type === "decisionThread" && event.decisionId === selected) {
      void loadDetail(event.decisionId);
    }
  });

  useEffect(() => {
    if (waiting && detail?.messages.at(-1)?.author !== "user") {
      setWaiting(false);
    }
  }, [detail?.messages, waiting]);

  useEffect(() => {
    bridge.current.commands = {
      item: (delta) => {
        if (selected) {
          setSelected((now) => stepIn(ids, now, delta));
          return;
        }
        // In the list, J and K move focus between the rows, so Enter opens one.
        const order = shown.map((item) => item.id);
        const focused = order.find((id) => rows.current.get(id) === document.activeElement) ?? null;
        const next = stepIn(order, focused, delta);
        if (next) {
          rows.current.get(next)?.focus();
        }
      },
      comment: () => input.current?.focus(),
    };
    return () => {
      bridge.current.commands = {};
    };
  }, [bridge, ids, selected, shown]);

  useEffect(() => {
    bridge.current.context = current
      ? {
          kind: "decision",
          label: `Decision: ${current.title}`,
          text: decisionBrief(current),
        }
      : null;
    return () => {
      bridge.current.context = null;
    };
  }, [bridge, current]);

  async function verdict(state: DecisionState, comment: string) {
    if (!current) {
      return;
    }
    try {
      const updated = await decisionSetState(current.id, state, comment || null);
      setDecisions((list) => list.map((item) => (item.id === updated.id ? updated : item)));
      setDraft("");
      void loadDetail(updated.id);
    } catch (err) {
      onError(errorText(err));
    }
  }

  async function comment(text: string) {
    if (!current || !text) {
      return;
    }
    try {
      await decisionComment(current.id, text);
      setDraft("");
      void loadDetail(current.id);
    } catch (err) {
      onError(errorText(err));
    }
  }

  async function send() {
    const text = asking.trim();
    if (!current || !text || waiting) {
      return;
    }
    setAsking("");
    setWaiting(true);
    try {
      await decisionPostMessage(current.id, text, null);
      void loadDetail(current.id);
    } catch (err) {
      setWaiting(false);
      setAsking(text);
      onError(errorText(err));
    }
  }

  function retry() {
    if (generation.kind === "failed") {
      void artifactRetry(generation.artifact.id)
        .then(load)
        .catch((err: unknown) => onError(errorText(err)));
    }
  }

  if (!session) {
    return <StateMessage text="Open or start a chat. The engineering decisions of its work show up here." title="Decisions" />;
  }

  if (loaded.kind === "loading") {
    return <StateMessage text="Loading the decisions of this chat…" title="Decisions" tone="loading" />;
  }

  if (loaded.kind === "failed") {
    return (
      <StateMessage text={`Could not load the decisions: ${loaded.message}`} title="Decisions" tone="failed">
        <Button
          variant="secondary"
          onClick={() => {
            setLoaded(LOADING);
            void load();
          }}
        >
          Try again
        </Button>
      </StateMessage>
    );
  }

  const dialogs = (
    <>
      <GenerateDialog
        isOpen={generating}
        session={session}
        onClose={() => setGenerating(false)}
        onError={onError}
        onStarted={() => void load()}
      />
      <NewDecisionDialog
        isOpen={creating}
        sessionId={session.id}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          void load().then(() => setSelected(created.id));
        }}
      />
    </>
  );

  if (decisions.length === 0) {
    return (
      <>
        {generation.kind === "working" ? (
          <StateMessage text={`Reading the changes with ${generation.label}…`} title="Decisions" tone="loading" />
        ) : generation.kind === "failed" ? (
          <StateMessage
            text={`Generating with ${generation.label} did not finish: ${generation.message}`}
            title="Decisions"
            tone="failed"
          >
            <div className="flex gap-2">
              <Button variant="secondary" onClick={retry}>
                Retry
              </Button>
              <Button variant="quiet" onClick={() => setGenerating(true)}>
                Generate with another model…
              </Button>
            </div>
          </StateMessage>
        ) : (
          <StateMessage
            text="No decisions yet. A decision is a choice in the code that deserves your verdict, kept as a thread while the code changes."
            title="Decisions"
          >
            <p className="max-w-[460px] text-small leading-5 text-cg-muted-strong">
              Generate them from the changes with the model you choose, ask the chat to record them, or open one
              yourself.
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setGenerating(true)}>
                Generate…
              </Button>
              <Button variant="primary" onClick={() => setCreating(true)}>
                New decision
              </Button>
            </div>
          </StateMessage>
        )}
        {dialogs}
      </>
    );
  }

  if (current) {
    return (
      <>
        <DecisionIssue
          decision={current}
          detail={detail}
          draft={draft}
          input={input}
          position={ids.indexOf(current.id) + 1}
          total={ids.length}
          onBack={() => setSelected(null)}
          onComment={(text) => void comment(text)}
          onDraft={setDraft}
          onOpenThread={() => setThreadOpen(true)}
          onStep={(delta) => setSelected(stepIn(ids, current.id, delta))}
          onVerdict={(state, text) => void verdict(state, text)}
        />
        <ThreadDialog
          ask={asking}
          decision={current}
          detail={detail}
          isOpen={threadOpen}
          waiting={waiting}
          onAsk={setAsking}
          onClose={() => setThreadOpen(false)}
          onLinkCommit={() => {
            setThreadOpen(false);
            setLinking(true);
          }}
          onOpenFile={(path, line) => {
            setThreadOpen(false);
            onOpenFile(path, line);
          }}
          onRequestChange={() => {
            setThreadOpen(false);
            setRequesting(true);
          }}
          onSend={() => void send()}
          onUnlinkCommit={(rev) =>
            void decisionUnlinkCommit(current.id, rev)
              .then(() => loadDetail(current.id))
              .catch((err: unknown) => onError(errorText(err)))
          }
        />
        <LinkCommitDialog
          decisionId={current.id}
          isOpen={linking}
          onClose={() => {
            setLinking(false);
            setThreadOpen(true);
          }}
          onError={onError}
          onLinked={() => void loadDetail(current.id)}
        />
        <CommentComposer
          isOpen={requesting}
          placeholder="What should the agent change?"
          submitLabel="Send to the agent"
          title={`Request a change · ${current.title}`}
          onClose={() => {
            setRequesting(false);
            setThreadOpen(true);
          }}
          onSubmit={async (text) => {
            try {
              await decisionRequestChange(current.id, text);
              void loadDetail(current.id);
            } catch (err) {
              onError(errorText(err));
              throw err;
            }
          }}
        />
        {dialogs}
      </>
    );
  }

  return (
    <>
      <DecisionList
        decisions={decisions}
        generation={generation}
        query={query}
        rows={rows}
        tab={tab}
        onGenerate={() => setGenerating(true)}
        onNew={() => setCreating(true)}
        onOpen={setSelected}
        onQuery={setQuery}
        onRetry={retry}
        onTab={setTab}
      />
      {dialogs}
    </>
  );
}
