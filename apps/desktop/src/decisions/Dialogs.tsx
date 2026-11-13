import { TextArea } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import { visibleProviders } from "../app/providers";
import { agentGetOptions, agentListProviders, PROVIDER_LABELS, type ModelChoice, type ProviderDescriptor } from "../lib/agent";
import {
  checkpointsList,
  decisionCommitCandidates,
  decisionCreate,
  decisionLinkCommit,
  decisionsGenerate,
  type Checkpoint,
  type CommitCandidate,
  type Decision,
  type DecisionKind,
} from "../lib/insights";
import { errorText } from "../lib/useInsightEvents";
import type { ChatSession, ProviderKind } from "../lib/workspace";
import { describeTarget } from "../code/model";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Dialog } from "../ui/Overlay";
import { QuietSelect } from "../ui/QuietSelect";
import { ago, KIND_LABEL } from "./model";

const FIELD = "w-full rounded-cg-md border border-cg-control px-2.5 py-1.5 text-ui text-cg-ink";
const INPUT =
  "w-full rounded-cg-md border border-cg-control bg-cg-panel px-3 py-1.5 text-ui text-cg-ink placeholder:text-cg-muted focus:border-cg-ink";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] items-center gap-x-3 text-small">
      <span className="text-cg-muted-strong">{label}</span>
      {children}
    </div>
  );
}

/**
 * Starts the generation of decisions. Nothing else does: this is where the reviewer says which
 * changes to read and which provider and model read them.
 */
export function GenerateDialog({
  isOpen,
  session,
  onClose,
  onStarted,
  onError,
}: {
  isOpen: boolean;
  session: ChatSession;
  onClose: () => void;
  onStarted: () => void;
  onError: (message: string) => void;
}) {
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [provider, setProvider] = useState<ProviderKind>(session.provider);
  const [live, setLive] = useState<ModelChoice[]>([]);
  const [model, setModel] = useState("");
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [checkpointId, setCheckpointId] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setProblem(null);
    setModel("");
    setProvider(session.provider);
    void Promise.all([agentListProviders(), checkpointsList(session.id)])
      .then(([list, points]) => {
        setProviders(visibleProviders(list, session.provider, import.meta.env.DEV));
        setCheckpoints(points);
        setCheckpointId(points.at(-1)?.id ?? "");
      })
      .catch((err: unknown) => onError(errorText(err)));
    // The chat's own provider reports the models it really has; the others use their presets.
    void agentGetOptions(session.id)
      .then((options) => setLive(options.models))
      .catch(() => setLive([]));
  }, [isOpen, session.id, session.provider, onError]);

  const descriptor = providers.find((item) => item.kind === provider);
  const models = useMemo(() => {
    const list = provider === session.provider && live.length > 0 ? live : (descriptor?.settings.models ?? []);
    return [
      { value: "", label: "Provider default" },
      ...list.map((item) => ({ value: item.id, label: item.label })),
    ];
  }, [descriptor, live, provider, session.provider]);
  const files = checkpoints.find((item) => item.id === checkpointId)?.files.length ?? 0;

  async function start() {
    if (!checkpointId || busy) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await decisionsGenerate(session.id, checkpointId, provider, model || null);
      onStarted();
      onClose();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog isOpen={isOpen} label="Generate decisions" size="md" onClose={onClose}>
      <form
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <div className="flex flex-col gap-1">
          <h2 className="text-heading font-semibold text-cg-ink">Generate decisions</h2>
          <p className="text-small leading-5 text-cg-muted-strong">
            A model reads the changes and opens a thread for each choice you should accept or reject. You can also ask
            the chat to record them, or open one yourself.
          </p>
        </div>
        <div className="flex flex-col gap-2.5">
          <Row label="Changes">
            <QuietSelect
              aria-label="Changes to read"
              className={FIELD}
              disabled={checkpoints.length === 0}
              options={[...checkpoints].reverse().map((item) => ({
                value: item.id,
                label: `#${item.seq} ${describeTarget(item)}`,
                hint: `${item.files.length} ${item.files.length === 1 ? "file" : "files"}`,
              }))}
              placeholder="Nothing has changed yet"
              value={checkpointId}
              onChange={setCheckpointId}
            />
          </Row>
          <Row label="Provider">
            <QuietSelect
              aria-label="Provider"
              className={FIELD}
              options={providers.map((item) => ({
                value: item.kind,
                label: item.display_name,
                disabled: !item.available,
                hint: item.available ? undefined : (item.detail ?? "Not installed"),
              }))}
              value={provider}
              onChange={(value) => {
                setProvider(value as ProviderKind);
                setModel("");
              }}
            />
          </Row>
          <Row label="Model">
            <QuietSelect
              aria-label="Model"
              className={FIELD}
              options={models}
              searchable={models.length > 8}
              value={model}
              onChange={setModel}
            />
          </Row>
        </div>
        <p className="text-small leading-5 text-cg-muted-strong">
          {files > 0
            ? `The diff of ${files} ${files === 1 ? "file" : "files"} is sent to ${PROVIDER_LABELS[provider]}. `
            : ""}
          Decisions that are already open are listed too, so a later change extends a thread instead of opening a twin.
        </p>
        {problem ? (
          <p className="text-small text-cg-red" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!checkpointId || busy || !descriptor?.available} type="submit" variant="primary">
            {busy ? "Starting…" : "Generate decisions"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Opens a decision by hand, the way one opens an issue. */
export function NewDecisionDialog({
  isOpen,
  sessionId,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  sessionId: string;
  onClose: () => void;
  onCreated: (decision: Decision) => void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [kind, setKind] = useState<DecisionKind>("other");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setTitle("");
      setSummary("");
      setKind("other");
      setProblem(null);
    }
  }, [isOpen]);

  async function create() {
    if (!title.trim() || busy) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      onCreated(await decisionCreate(sessionId, title.trim(), summary.trim(), kind));
      onClose();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog isOpen={isOpen} label="New decision" size="md" onClose={onClose}>
      <form
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <h2 className="text-heading font-semibold text-cg-ink">New decision</h2>
        <label className="flex flex-col gap-1 text-small text-cg-muted-strong">
          Title
          <input
            autoFocus
            className={INPUT}
            placeholder="A question or a short statement"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-small text-cg-muted-strong">
          What is being decided
          <TextArea
            className="min-h-[88px] text-ui"
            fullWidth
            placeholder="Optional. What changed, and why it needs a verdict."
            rows={3}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        <Row label="Kind">
          <QuietSelect
            aria-label="Kind"
            className={FIELD}
            options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))}
            value={kind}
            onChange={(value) => setKind(value as DecisionKind)}
          />
        </Row>
        {problem ? (
          <p className="text-small text-cg-red" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!title.trim() || busy} type="submit" variant="primary">
            Open decision
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Says that a commit influences a decision. Commits that touched the decision's code come first. */
export function LinkCommitDialog({
  isOpen,
  decisionId,
  onClose,
  onLinked,
  onError,
}: {
  isOpen: boolean;
  decisionId: string;
  onClose: () => void;
  onLinked: () => void;
  onError: (message: string) => void;
}) {
  const [candidates, setCandidates] = useState<CommitCandidate[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setCandidates(null);
    setPicked(null);
    setTyped("");
    setNote("");
    setProblem(null);
    decisionCommitCandidates(decisionId)
      .then((list) => {
        setCandidates(list);
        setPicked(list.find((item) => !item.linked)?.commit.rev ?? null);
      })
      .catch((err: unknown) => {
        setCandidates([]);
        onError(errorText(err));
      });
  }, [isOpen, decisionId, onError]);

  const rev = typed.trim() || picked;
  const touching = (candidates ?? []).filter((item) => item.touchesDecisionFiles);
  const others = (candidates ?? []).filter((item) => !item.touchesDecisionFiles);

  async function link() {
    if (!rev || busy) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await decisionLinkCommit(decisionId, rev, note.trim());
      onLinked();
      onClose();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function group(title: string, items: CommitCandidate[]) {
    if (items.length === 0) {
      return null;
    }
    return (
      <section className="flex flex-col gap-1">
        <h3 className="text-small font-semibold text-cg-muted-strong">{title}</h3>
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.commit.rev}>
              <button
                aria-pressed={!typed.trim() && picked === item.commit.rev}
                className="flex w-full items-baseline gap-2 rounded-cg-sm px-2 py-1.5 text-left text-small hover:bg-cg-tint aria-pressed:bg-cg-accent-bg"
                type="button"
                onClick={() => {
                  setPicked(item.commit.rev);
                  setTyped("");
                }}
              >
                <span className="flex-none font-mono text-small text-cg-muted-strong">{item.commit.short}</span>
                <span className="min-w-0 flex-1 truncate text-cg-ink" title={item.commit.subject}>
                  {item.commit.subject}
                </span>
                {item.linked ? <Chip>Linked</Chip> : null}
                <span className="flex-none text-small text-cg-muted">
                  {item.commit.author ? `${item.commit.author}, ` : ""}
                  {ago(item.commit.date)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <Dialog isOpen={isOpen} label="Link a commit" size="md" onClose={onClose}>
      <form
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void link();
        }}
      >
        <div className="flex flex-col gap-1">
          <h2 className="text-heading font-semibold text-cg-ink">Link a commit</h2>
          <p className="text-small leading-5 text-cg-muted-strong">
            Say that a commit settles, changes or contradicts this decision. The decision stays open and keeps its
            history whatever the code does.
          </p>
        </div>
        <div className="flex max-h-[240px] flex-col gap-3 overflow-y-auto">
          {candidates === null ? (
            <p className="text-small text-cg-muted-strong" role="status">
              Reading the history…
            </p>
          ) : candidates.length === 0 ? (
            <p className="text-small text-cg-muted-strong">No commits found here. Type one below.</p>
          ) : (
            <>
              {group("Touched the code this decision is about", touching)}
              {group(touching.length > 0 ? "Other recent commits" : "Recent commits", others)}
            </>
          )}
        </div>
        <label className="flex flex-col gap-1 text-small text-cg-muted-strong">
          Or type a commit, branch or tag
          <input
            className={`${INPUT} font-mono`}
            placeholder="a1b2c3d, HEAD~2, v1.2"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-small text-cg-muted-strong">
          What the commit did to this decision
          <input
            className={INPUT}
            placeholder="Optional. For example: implements it, or reverses it."
            value={note}
            onChange={(event) => setNote(event.target.value)}
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
          <Button disabled={!rev || busy} type="submit" variant="primary">
            Link commit
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
