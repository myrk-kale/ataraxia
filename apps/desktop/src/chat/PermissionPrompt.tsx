import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { PendingPermission, PermissionQuestion, PermissionResponseOptions } from "../lib/agent";
import { Button } from "../ui/Button";

/** Answers the agent. A promise settles to `false` when the answer did not go through. */
type Resolve = (
  allow: boolean,
  answers?: Record<string, string>,
  options?: PermissionResponseOptions,
) => void | Promise<boolean>;

const FIELD = "cg-field rounded-cg-lg bg-cg-tint px-4 py-3.5";

const ROW =
  "flex w-full cursor-pointer items-start gap-2.5 rounded-cg-md px-2.5 py-2 text-left text-ui text-cg-ink outline-none hover:bg-cg-line focus-visible:bg-cg-line";

/** The rows of a prompt, in the order they are on screen. */
function rowsOf(root: HTMLElement | null): HTMLElement[] {
  return root ? [...root.querySelectorAll<HTMLElement>("[data-row]")] : [];
}

/**
 * Keys shared by both prompts: the arrows move between the rows, a number takes that row, and
 * Esc declines. The rows are real buttons, so Enter and Space work as they do anywhere.
 */
function useRowKeys(onSkip: () => void) {
  const root = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const rows = rowsOf(root.current);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (!typing && at !== -1 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      rows[(at + step + rows.length) % rows.length]?.focus();
    } else if (event.key === "Escape") {
      // The prompt is answered by declining; it must not also stop the turn behind it.
      event.preventDefault();
      event.stopPropagation();
      onSkip();
    } else if (!typing && /^[1-9]$/.test(event.key)) {
      const row = rows.filter((item) => item.dataset.number)[Number(event.key) - 1];
      if (row) {
        event.preventDefault();
        row.click();
      }
    }
  }

  return { root, onKeyDown };
}

function Digit({ n }: { n: number }) {
  return <span className="w-4 flex-none text-right text-cg-muted tabular-nums">{n}.</span>;
}

function Approval({ pending, onResolve }: { pending: PendingPermission; onResolve: Resolve }) {
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState("");
  const first = useRef<HTMLButtonElement>(null);
  const redirect = useRef<HTMLButtonElement>(null);
  const instructionField = useRef<HTMLTextAreaElement>(null);
  const keys = useRowKeys(editing ? closeInstruction : () => onResolve(false));
  const detail = pending.detail.includes(pending.toolName) ? pending.detail
    : `${pending.toolName}\n${pending.detail}`;
  const longDetail = detail.length > 220 || detail.split("\n", 4).length > 3;
  const detailClass = "max-h-[min(9rem,25vh)] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-small text-cg-muted-strong";

  useEffect(() => first.current?.focus(), []);
  useEffect(() => {
    if (editing) instructionField.current?.focus();
  }, [editing]);

  function closeInstruction() {
    setEditing(false);
    redirect.current?.focus();
  }

  function sendInstruction() {
    const text = instruction.trim();
    if (text) onResolve(false, undefined, { instruction: text });
  }

  return (
    <div
      ref={keys.root}
      aria-label="Permission needed"
      className={FIELD}
      role="group"
      onKeyDown={keys.onKeyDown}
    >
      <p className="text-small font-semibold text-cg-muted-strong">Permission needed</p>
      {longDetail ? (
        <details className="mt-2 rounded-cg-md bg-cg-panel px-3 py-2">
          <summary className="cursor-pointer text-small text-cg-ink">
            Request details
            <span className="mt-1 line-clamp-2 [overflow-wrap:anywhere] font-mono text-cg-muted-strong">
              {detail.slice(0, 160)}…
            </span>
          </summary>
          <pre className={`mt-2 ${detailClass}`} tabIndex={0} aria-label="Permission request details">
            {detail}
          </pre>
        </details>
      ) : (
        <pre className={`mt-2 rounded-cg-md bg-cg-panel px-3 py-2 ${detailClass}`}>{detail}</pre>
      )}
      <div className="mt-2.5 space-y-0.5">
        <button
          ref={first}
          className={ROW}
          data-number="1"
          data-row
          type="button"
          onClick={() => onResolve(true)}
        >
          <Digit n={1} />
          <span className="font-medium">Yes</span>
        </button>
        <button
          className={ROW}
          data-number="2"
          data-row
          type="button"
          onClick={() => onResolve(false)}
        >
          <Digit n={2} />
          <span className="font-medium">No</span>
        </button>
        <button
          ref={redirect}
          className={ROW}
          data-number="3"
          data-row
          aria-expanded={editing}
          type="button"
          onClick={() => setEditing(true)}
        >
          <Digit n={3} />
          <span className="font-medium">No, give instructions</span>
        </button>
        {pending.allowAlways ? (
          <button
            className={ROW}
            data-number="4"
            data-row
            type="button"
            onClick={() => onResolve(true, undefined, { remember: true })}
          >
            <Digit n={4} />
            <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere] font-medium">
              {pending.allowAlways}
            </span>
          </button>
        ) : null}
      </div>
      {editing ? (
        <form
          className="mt-2 flex flex-col gap-2 px-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            sendInstruction();
          }}
        >
          <label className="flex flex-col gap-1 text-small text-cg-muted-strong">
            What should the agent do instead?
            <textarea
              ref={instructionField}
              className="w-full rounded-cg-md border border-cg-control bg-cg-panel px-2.5 py-2 text-ui text-cg-ink"
              rows={2}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={closeInstruction}>Back</Button>
            <Button size="sm" variant="primary" type="submit" disabled={!instruction.trim()}>
              Send instructions
            </Button>
          </div>
        </form>
      ) : (
        <p className="mt-2 px-2.5 text-small text-cg-muted">↑↓ to move · Enter to choose · Esc to decline</p>
      )}
    </div>
  );
}

/** What was picked and written for one question, kept so going back finds it as it was left. */
type Draft = { picked: string[]; written: string };

/** The answer as the agent receives it. */
function answerOf(draft: Draft): string {
  return (draft.written ? [...draft.picked, draft.written] : draft.picked).join(", ");
}

/**
 * One question: its options, a line for another answer, and, if several may be picked, a button.
 * It can be passed without an answer, and, after the first, taken back to the one before.
 */
function Question({
  question,
  position,
  total,
  initial,
  onAnswer,
  onSkip,
  onBack,
  onDismiss,
}: {
  question: PermissionQuestion;
  position: number;
  total: number;
  initial: Draft | undefined;
  onAnswer: (draft: Draft) => void;
  onSkip: () => void;
  onBack: (() => void) | null;
  onDismiss: () => void;
}) {
  const keys = useRowKeys(onDismiss);
  const [chosen, setChosen] = useState<string[]>(initial?.picked ?? []);
  const [other, setOther] = useState(initial?.written ?? "");
  const written = other.trim();
  const multi = question.multiSelect;

  // The first option has the focus when a question comes up.
  useEffect(() => rowsOf(keys.root.current)[0]?.focus(), [keys.root]);

  function send() {
    const picked = question.options
      .map((option) => option.label)
      .filter((label) => chosen.includes(label));
    if (picked.length > 0 || written) {
      onAnswer({ picked: multi ? picked : [], written });
    }
  }

  function choose(label: string) {
    if (!multi) {
      onAnswer({ picked: [label], written: "" });
      return;
    }
    setChosen((all) => (all.includes(label) ? all.filter((item) => item !== label) : [...all, label]));
  }

  const count = question.options.length;
  return (
    <div
      ref={keys.root}
      aria-label={question.question}
      className={FIELD}
      role="group"
      onKeyDown={keys.onKeyDown}
    >
      <p className="text-small font-semibold text-cg-muted-strong">
        {[question.header, total > 1 ? `Question ${position} of ${total}` : ""]
          .filter(Boolean)
          .join(" · ") || "The agent asks"}
      </p>
      <p className="mt-1.5 text-body leading-snug font-semibold">{question.question}</p>
      <div className="mt-2.5 space-y-0.5">
        {question.options.map((option, index) => (
          <button
            key={option.label}
            aria-checked={multi ? chosen.includes(option.label) : undefined}
            aria-current={!multi && chosen.includes(option.label) ? "true" : undefined}
            className={ROW}
            data-number={index + 1}
            data-row
            role={multi ? "checkbox" : undefined}
            type="button"
            onClick={() => choose(option.label)}
          >
            <Digit n={index + 1} />
            {multi ? (
              <span
                aria-hidden="true"
                className={`mt-[3px] grid h-3.5 w-3.5 flex-none place-items-center rounded-[3px] border text-[10px] leading-none ${
                  chosen.includes(option.label)
                    ? "border-cg-primary bg-cg-primary text-cg-on-primary"
                    : "border-cg-line-strong"
                }`}
              >
                {chosen.includes(option.label) ? "✓" : ""}
              </span>
            ) : null}
            <span className="min-w-0">
              <span className="block font-medium">
                {option.label}
                {!multi && chosen.includes(option.label) ? (
                  <span aria-hidden="true" className="ml-1.5 text-cg-primary">
                    ✓
                  </span>
                ) : null}
              </span>
              {option.description ? (
                <span className="block text-small text-cg-muted-strong">{option.description}</span>
              ) : null}
            </span>
          </button>
        ))}
        <label className={`${ROW} cursor-text items-center focus-within:bg-cg-line`}>
          <Digit n={count + 1} />
          <input
            aria-label="Type another answer"
            autoComplete="off"
            className="min-w-0 flex-1 border-0 bg-transparent text-ui text-cg-ink outline-none placeholder:text-cg-muted"
            data-row
            placeholder="Type something else…"
            spellCheck={false}
            value={other}
            onChange={(event) => setOther(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && written) {
                event.preventDefault();
                if (multi) {
                  send();
                } else {
                  onAnswer({ picked: [], written });
                }
              }
            }}
          />
        </label>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-3 px-2.5">
        <p className="text-small text-cg-muted">
          ↑↓ to move · {multi ? "Space to tick" : "Enter to choose"} · Esc to dismiss
        </p>
        <div className="flex gap-2">
          {onBack ? (
            <Button size="sm" onClick={onBack}>
              Back
            </Button>
          ) : null}
          <Button size="sm" onClick={onSkip}>
            Skip
          </Button>
          {multi || count === 0 || written ? (
            <Button
              disabled={chosen.length === 0 && !written}
              size="sm"
              variant="primary"
              onClick={send}
            >
              {position < total ? "Next" : "Send"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Goes through the agent's questions one at a time; the answers go back together. A question can
 * be passed over and the one before taken back to, keeping what was answered. Declining every
 * question, or reaching the end with none answered, declines the request.
 */
function Questions({
  questions,
  onResolve,
}: {
  questions: PermissionQuestion[];
  onResolve: Resolve;
}) {
  const [step, setStep] = useState(0);
  // Keyed by position: two questions may be worded alike. A passed question has no entry.
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const question = questions[step];

  function finish(all: Record<number, Draft>) {
    const answers = Object.fromEntries<string>(questions.flatMap((item, index) => {
      const draft = all[index];
      return draft ? [[item.question, answerOf(draft)]] : [];
    }));
    if (Object.keys(answers).length > 0) {
      onResolve(true, answers);
    } else {
      onResolve(false);
    }
  }

  function advance(all: Record<number, Draft>) {
    setDrafts(all);
    if (step + 1 < questions.length) {
      setStep(step + 1);
    } else {
      finish(all);
    }
  }

  return (
    <Question
      key={step}
      initial={drafts[step]}
      position={step + 1}
      question={question}
      total={questions.length}
      onAnswer={(draft) => advance({ ...drafts, [step]: draft })}
      onBack={step > 0 ? () => setStep(step - 1) : null}
      onDismiss={() => onResolve(false)}
      onSkip={() => {
        const { [step]: _passed, ...rest } = drafts;
        advance(rest);
      }}
    />
  );
}

/**
 * What the agent needs from the person, shown where the message field is, as Claude Code does:
 * a permission to give, or questions to answer with the options it suggests or words of the
 * person's own. The field comes back once it is settled.
 */
export function PermissionPrompt({
  pending,
  onResolve,
}: {
  pending: PendingPermission;
  onResolve: Resolve;
}) {
  const questions = pending.questions ?? [];
  // A request is answered once: a second click, or a key held down, on the answer that is already
  // on its way would reach the app after it has closed the request and come back as an error.
  const settled = useRef<string | null>(null);
  const once: Resolve = (...answer) => {
    if (settled.current === pending.requestId) {
      return;
    }
    settled.current = pending.requestId;
    const outcome = onResolve(...answer);
    if (outcome instanceof Promise) {
      // An answer that did not go through can be given again.
      void outcome.then((ok) => {
        if (!ok && settled.current === pending.requestId) {
          settled.current = null;
        }
      });
    }
  };
  return questions.length > 0 ? (
    <Questions key={pending.requestId} questions={questions} onResolve={once} />
  ) : (
    <Approval key={pending.requestId} pending={pending} onResolve={once} />
  );
}
