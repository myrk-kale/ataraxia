import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { PendingPermission, PermissionQuestion } from "../lib/agent";
import { Button } from "../ui/Button";

type Resolve = (allow: boolean, answers?: Record<string, string>) => void;

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
    const typing = event.target instanceof HTMLInputElement;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
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
  const keys = useRowKeys(() => onResolve(false));
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => first.current?.focus(), []);

  return (
    <div
      ref={keys.root}
      aria-label="Permission needed"
      className={FIELD}
      role="group"
      onKeyDown={keys.onKeyDown}
    >
      <p className="text-small font-semibold text-cg-muted-strong">Permission needed</p>
      <p className="mt-1.5 text-body leading-snug font-semibold">{pending.detail}</p>
      <p className="mt-2 rounded-cg-md bg-cg-panel px-3 py-2 font-mono text-small text-cg-muted-strong">
        {pending.toolName}
      </p>
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
      </div>
      <p className="mt-2 px-2.5 text-small text-cg-muted">↑↓ to move · Enter to choose · Esc to decline</p>
    </div>
  );
}

/** One question: its options, a line for another answer, and, if several may be picked, a button. */
function Question({
  question,
  position,
  total,
  onAnswer,
  onSkip,
}: {
  question: PermissionQuestion;
  position: number;
  total: number;
  onAnswer: (answer: string) => void;
  onSkip: () => void;
}) {
  const keys = useRowKeys(onSkip);
  const [chosen, setChosen] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const written = other.trim();
  const multi = question.multiSelect;

  // The first option has the focus when a question comes up.
  useEffect(() => rowsOf(keys.root.current)[0]?.focus(), [keys.root]);

  function send() {
    const picked = question.options
      .map((option) => option.label)
      .filter((label) => chosen.includes(label));
    const answer = (written ? [...picked, written] : picked).join(", ");
    if (answer) {
      onAnswer(answer);
    }
  }

  function choose(label: string) {
    if (!multi) {
      onAnswer(label);
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
              <span className="block font-medium">{option.label}</span>
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
                  onAnswer(written);
                }
              }
            }}
          />
        </label>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-3 px-2.5">
        <p className="text-small text-cg-muted">
          ↑↓ to move · {multi ? "Space to tick" : "Enter to choose"} · Esc to skip
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={onSkip}>
            Skip
          </Button>
          {multi ? (
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

/** Goes through the agent's questions one at a time; the answers go back together. */
function Questions({
  questions,
  onResolve,
}: {
  questions: PermissionQuestion[];
  onResolve: Resolve;
}) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const question = questions[step];

  return (
    <Question
      key={step}
      position={step + 1}
      question={question}
      total={questions.length}
      onAnswer={(answer) => {
        const next = { ...answers, [question.question]: answer };
        if (step + 1 < questions.length) {
          setAnswers(next);
          setStep(step + 1);
        } else {
          onResolve(true, next);
        }
      }}
      onSkip={() => onResolve(false)}
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
  return questions.length > 0 ? (
    <Questions key={pending.requestId} questions={questions} onResolve={onResolve} />
  ) : (
    <Approval key={pending.requestId} pending={pending} onResolve={onResolve} />
  );
}
