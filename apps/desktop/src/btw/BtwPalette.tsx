import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "../chat/ChatPanel";
import { Markdown } from "../chat/Markdown";
import {
  agentGetOptions,
  agentGetSnapshot,
  listenAgentEvents,
  type ModelChoice,
  type ProviderDescriptor,
} from "../lib/agent";
import { btwList, btwSession, btwStart, type BtwContextItem, type BtwTask } from "../lib/insights";
import { errorText, useInsightEvents } from "../lib/useInsightEvents";
import type { ChatSession } from "../lib/workspace";
import { Dialog } from "../ui/Overlay";
import { QuietSelect } from "../ui/QuietSelect";
import { doneInAtaraxia, lastAnswer, withoutActions } from "./answer";
import { decodePick, modelChoices, startingChoice } from "./models";

type Phase = "ask" | "running" | "done" | "failed";

const MODEL_KEY = "ataraxia.btwModel";

function remembered(): string | null {
  try {
    return window.localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
}

/**
 * The BTW bar, in the manner of Spotlight: summoned by shortcut only, one wide rounded field with
 * nothing in it but its placeholder and, joined to its body, the choice of which model runs the
 * question. It answers below the bar. It can also comment on a component, change a priority, or
 * generate decisions or a diagram, but only when asked; and when it finishes, the main chat is
 * told what was asked and what was done.
 */
export function BtwPalette({
  isOpen,
  onClose,
  session,
  space,
  item,
  others,
  providers,
  resume,
  onError,
}: {
  isOpen: boolean;
  onClose: () => void;
  session: ChatSession | null;
  space: string;
  item: BtwContextItem | null;
  /** What the other spaces have open (file, decision, diagram), so it is known from any of them. */
  others: BtwContextItem[];
  providers: ProviderDescriptor[];
  /** A past investigation to reopen, from the session's history. */
  resume: BtwTask | null;
  onError: (message: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const [phase, setPhase] = useState<Phase>("ask");
  const [answer, setAnswer] = useState("");
  const [task, setTask] = useState<BtwTask | null>(null);
  const [expanded, setExpanded] = useState<ChatSession | null>(null);
  const [live, setLive] = useState<ModelChoice[]>([]);
  // Only a pick the user made is kept; until then the BTW follows the model the chat is on.
  const [picked, setPicked] = useState<string | null>(remembered);
  const [choice, setChoice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const sessionId = session?.id ?? null;

  const options = useMemo(
    () => modelChoices(providers, session, live, import.meta.env.DEV),
    [providers, session, live],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setQuestion("");
    setPhase("ask");
    setAnswer("");
    setTask(null);
    setExpanded(null);
    if (resume) {
      setTask(resume);
      void btwSession(resume.id)
        .then(setExpanded)
        .catch((err: unknown) => onError(errorText(err)));
      return;
    }
    if (sessionId) {
      void agentGetOptions(sessionId)
        .then((found) => setLive(found.models))
        .catch(() => setLive([]));
    }
    requestAnimationFrame(() => input.current?.focus());
  }, [isOpen, resume, sessionId, onError]);

  // What runs it: the user's own pick if it is still on offer, else the model the chat uses now.
  useEffect(() => {
    setChoice(startingChoice(options, session, picked));
  }, [options, session, picked]);

  function pickModel(value: string) {
    setPicked(value);
    try {
      window.localStorage.setItem(MODEL_KEY, value);
    } catch {
      // Not remembering the choice is harmless.
    }
  }

  // The answer streams in through the same events as any conversation.
  const taskSession = task?.session_id ?? null;
  useEffect(() => {
    if (!taskSession || expanded) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const refresh = async () => {
      try {
        const snapshot = await agentGetSnapshot(taskSession);
        if (!disposed) {
          setAnswer(lastAnswer(snapshot.items));
        }
      } catch {
        // The conversation may not be started yet; the next event retries.
      }
    };
    void listenAgentEvents((event) => {
      if (event.sessionId !== taskSession) {
        return;
      }
      if (event.type === "delta" && event.role === "assistant") {
        setAnswer((text) => text + event.text);
      } else if (event.type === "turnDone") {
        setPhase(event.ok ? "done" : "failed");
        void refresh();
      } else if (event.type === "error") {
        setPhase("failed");
        setAnswer(event.message);
      }
    }).then((stop) => {
      if (disposed) {
        stop();
      } else {
        unlisten = stop;
      }
    });
    void refresh();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [taskSession, expanded]);

  // What BTW did in Ataraxia, and whether the main chat has heard, arrive after the answer does.
  const taskId = task?.id ?? null;
  const refreshTask = useCallback(async () => {
    if (!sessionId || !taskId) {
      return;
    }
    try {
      const latest = (await btwList(sessionId)).find((candidate) => candidate.id === taskId);
      if (latest) {
        setTask(latest);
      }
    } catch {
      // The next event tries again.
    }
  }, [sessionId, taskId]);
  useInsightEvents((event) => {
    if (event.type === "btw" && event.taskId === taskId) {
      void refreshTask();
    }
  });
  useEffect(() => {
    if (phase === "done") {
      void refreshTask();
    }
  }, [phase, refreshTask]);

  async function submit() {
    const text = question.trim();
    if (!sessionId || !text || phase === "running") {
      return;
    }
    setPhase("running");
    setAnswer("");
    setTask(null);
    const pick = choice ? decodePick(choice) : null;
    try {
      setTask(
        await btwStart(sessionId, "ask", text, { space, item, active: others }, "on-completion", false, pick?.provider ?? null, pick?.model ?? null),
      );
      setQuestion("");
    } catch (err) {
      setPhase("ask");
      onError(errorText(err));
    }
  }

  if (expanded) {
    return (
      <Dialog isOpen={isOpen} label="BTW conversation" size="lg" placement="center" onClose={onClose}>
        <div className="flex h-[78vh] min-h-0 w-full flex-col">
          <div className="flex items-center gap-3 border-b border-cg-line px-5 py-3 text-small text-cg-muted-strong">
            <span className="min-w-0 flex-1 truncate font-medium text-cg-ink">{expanded.title}</span>
            <span className="flex-none">{expanded.kind === "delegate" ? "Delegated change" : "Read-only"}</span>
            {task ? <MainChatNote task={task} /> : null}
          </div>
          <div className="min-h-0 flex-1">
            <ChatPanel
              bare
              contextLabel={null}
              provider={providers.find((candidate) => candidate.kind === expanded.provider) ?? null}
              session={expanded}
              onSessionChange={setExpanded}
            />
          </div>
        </div>
      </Dialog>
    );
  }

  const done = doneInAtaraxia(task?.summary ?? null);
  const shown = withoutActions(answer);
  const hasResult = phase !== "ask" || Boolean(shown);

  return (
    <Dialog isOpen={isOpen} label="BTW" placement="top" size="lg" wide onClose={onClose}>
      <div className="flex w-full flex-col">
        <form
          className="flex items-center gap-1 pr-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            ref={input}
            aria-label="Ask about what you are looking at"
            autoComplete="off"
            className="min-w-0 flex-1 border-0 bg-transparent py-3 pl-5 text-body text-cg-ink placeholder:text-cg-muted"
            disabled={!session}
            placeholder={session ? "Ask about what you are looking at…" : "Open a chat first"}
            readOnly={phase === "running"}
            spellCheck={false}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") {
                return;
              }
              // The model list holds a search field of its own inside this form, which switches
              // off the browser's own Enter-to-submit, so Enter is handled here.
              event.preventDefault();
              if (!event.nativeEvent.isComposing) {
                void submit();
              }
            }}
          />
          <div className="flex-none">
            <QuietSelect
              aria-label="Model that runs it"
              sound
              className="max-w-[240px] rounded-cg-md px-2 py-1 text-small text-cg-muted-strong"
              disabled={!session || options.length === 0 || phase === "running"}
              options={options}
              searchable={options.length > 8}
              title="The model that answers this question"
              value={choice}
              onChange={pickModel}
            />
          </div>
        </form>

        {hasResult ? (
          <div className="flex flex-col gap-3 border-t border-cg-line px-5 py-3.5">
            <div aria-live="polite" className="max-h-[46vh] overflow-y-auto text-ui leading-6 text-cg-ink">
              {shown ? (
                <Markdown text={shown} />
              ) : phase === "running" ? (
                <span className="inline-flex items-center gap-2 text-cg-muted-strong">
                  <Loader2 aria-hidden="true" className="animate-spin" size={13} />
                  Looking at the code…
                </span>
              ) : null}
              {phase === "failed" && !shown ? <span className="text-cg-red">The investigation did not finish.</span> : null}
            </div>
            {done.length > 0 ? (
              <section aria-label="Done in Ataraxia" className="flex flex-col gap-1 rounded-cg-md bg-cg-tint px-3.5 py-2.5">
                <h3 className="text-small font-semibold text-cg-muted-strong">Done in Ataraxia</h3>
                <ul className="flex flex-col gap-0.5 text-small leading-5 text-cg-ink">
                  {done.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            {task && phase === "done" ? <MainChatNote task={task} /> : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Whether the main chat has been told what this BTW asked and did. */
export function MainChatNote({ task }: { task: BtwTask }) {
  if (task.status !== "ready") {
    return null;
  }
  const told = Boolean(task.returned_at) && task.returned_at! >= task.updated_at;
  return told ? (
    <span className="inline-flex flex-none items-center gap-1 text-small text-cg-green">
      <Check aria-hidden="true" size={12} />
      The main chat was told
    </span>
  ) : (
    <span aria-live="polite" className="flex-none text-small text-cg-muted-strong">
      The main chat is busy. It is told as soon as its turn ends.
    </span>
  );
}
