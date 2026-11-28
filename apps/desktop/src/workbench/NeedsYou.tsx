import { ChevronDown, ChevronRight, CircleAlert, CircleHelp, GitCompare, Hand, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { EntryView, FileRow, MemberView, NeedKind, NeedView, Resolution, TopicView } from "../lib/workbench";
import { Button } from "../ui/Button";
import { rangesText } from "./model";
import { ReplyBox } from "./parts";

const KIND_ICON: Record<NeedKind, ReactNode> = {
  question: <CircleHelp aria-hidden="true" size={14} />,
  disagreement: <GitCompare aria-hidden="true" size={14} />,
  collision: <TriangleAlert aria-hidden="true" size={14} />,
  approval: <Hand aria-hidden="true" size={14} />,
};

/** What identifies an item between two reads, so the one that is open stays open. */
export function needKey(need: NeedView): string {
  return `${need.kind}:${need.entryId ?? need.path ?? need.sessionIds.join(",")}`;
}

/**
 * What waits for the developer, kept apart from the stream so it is never buried in it: a question
 * an agent put to them, two agents who disagree, two agents on the same lines, an agent waiting for
 * approval. Each is a line; the one at the top is open, with the one or two things to do about it,
 * and the rest are a press away, so the board stays in view however much is waiting.
 */
export function NeedsYou({
  needs,
  byId,
  topics,
  files,
  members,
  onAnswer,
  onResolve,
  onTell,
  onOpenChat,
}: {
  needs: readonly NeedView[];
  byId: ReadonlyMap<string, EntryView>;
  topics: readonly TopicView[];
  files: readonly FileRow[];
  members: readonly MemberView[];
  onAnswer: (entryId: string, text: string) => Promise<void>;
  onResolve: (entryId: string, resolution: Resolution) => Promise<void>;
  /** Says something to one agent. */
  onTell: (sessionId: string, text: string) => Promise<void>;
  onOpenChat: (sessionId: string) => void;
}) {
  // `undefined`: nothing chosen, so the first item is the open one; `null`: all closed.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const [folded, setFolded] = useState(false);
  if (needs.length === 0) {
    return null;
  }
  const keys = needs.map(needKey);
  const open = chosen === undefined || (chosen !== null && !keys.includes(chosen)) ? keys[0]! : chosen;
  return (
    <section aria-label="Needs you" className="flex max-h-[42%] flex-none flex-col border-b border-cg-line bg-cg-sidebar">
      <h2 className="flex-none px-6 pt-2 pb-1">
        <button
          aria-expanded={!folded}
          className="-ml-2 flex items-center gap-1.5 rounded-cg-sm px-2 py-1 text-small font-semibold text-cg-amber-text hover:bg-cg-tint"
          type="button"
          onClick={() => setFolded((on) => !on)}
        >
          <CircleAlert aria-hidden="true" size={13} />
          Needs you
          <span className="font-normal text-cg-muted">{needs.length}</span>
          {folded ? <ChevronRight aria-hidden="true" className="text-cg-muted" size={13} /> : <ChevronDown aria-hidden="true" className="text-cg-muted" size={13} />}
        </button>
      </h2>
      <ul className={`mx-auto min-h-0 w-full max-w-[928px] flex-col gap-1.5 overflow-y-auto px-6 pb-3 ${folded ? "hidden" : "flex"}`}>
        {needs.map((need) => {
          const key = needKey(need);
          return (
            <NeedCard
              key={key}
              byId={byId}
              files={files}
              members={members}
              need={need}
              open={open === key}
              topics={topics}
              onAnswer={onAnswer}
              onOpenChat={onOpenChat}
              onResolve={onResolve}
              onTell={onTell}
              onToggle={() => setChosen(open === key ? null : key)}
            />
          );
        })}
      </ul>
    </section>
  );
}

function NeedCard({
  need,
  open,
  byId,
  topics,
  files,
  members,
  onToggle,
  onAnswer,
  onResolve,
  onTell,
  onOpenChat,
}: {
  need: NeedView;
  open: boolean;
  byId: ReadonlyMap<string, EntryView>;
  topics: readonly TopicView[];
  files: readonly FileRow[];
  members: readonly MemberView[];
  onToggle: () => void;
  onAnswer: (entryId: string, text: string) => Promise<void>;
  onResolve: (entryId: string, resolution: Resolution) => Promise<void>;
  onTell: (sessionId: string, text: string) => Promise<void>;
  onOpenChat: (sessionId: string) => void;
}) {
  const [answering, setAnswering] = useState(false);
  const [told, setTold] = useState(false);
  const entry = need.entryId ? byId.get(need.entryId) : undefined;
  const standing = entry?.topic ? topics.find((topic) => topic.topic.toLowerCase() === entry.topic?.toLowerCase())?.standing : null;
  const row = need.path ? files.find((file) => file.path === need.path) : undefined;
  const nameOf = (id: string) => members.find((member) => member.sessionId === id)?.title ?? "another agent";

  async function tellThem() {
    if (!need.path) {
      return;
    }
    const clashing = need.sessionIds;
    for (const id of clashing) {
      const others = clashing.filter((other) => other !== id).map(nameOf);
      await onTell(
        id,
        `You and ${others.join(", ")} changed the same lines of ${need.path}. Settle it on the workbench: ask each other, and one of you gives way.`,
      );
    }
    setTold(true);
  }

  return (
    <li className="rounded-cg-md border border-cg-line-strong border-l-2 border-l-cg-amber bg-cg-panel">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-cg-md px-3 py-2.5 text-left hover:bg-cg-tint"
        type="button"
        onClick={onToggle}
      >
        <span className="flex-none text-cg-amber-text">{KIND_ICON[need.kind]}</span>
        <span className={`min-w-0 flex-1 text-ui font-semibold text-cg-ink ${open ? "" : "truncate"}`}>{need.title}</span>
        {open ? (
          <ChevronDown aria-hidden="true" className="flex-none text-cg-muted" size={14} />
        ) : (
          <ChevronRight aria-hidden="true" className="flex-none text-cg-muted" size={14} />
        )}
      </button>

      {open ? (
        <div className="px-3 pb-3 pl-[2.375rem]">
          {need.kind === "question" ? <p className="text-ui leading-6 whitespace-pre-wrap text-cg-ink">{need.detail}</p> : null}

          {need.kind === "disagreement" && entry ? (
            <dl className="grid gap-2 text-ui leading-6 sm:grid-cols-2">
              <div className="rounded-cg-sm bg-cg-tint px-2.5 py-2">
                <dt className="text-small font-semibold text-cg-muted-strong">
                  Stands{standing ? ` · ${standing.author === null ? "you" : standing.authorLabel}` : ""}
                </dt>
                <dd className="text-cg-ink">{standing ? standing.text : "Nothing stands now."}</dd>
              </div>
              <div className="rounded-cg-sm bg-cg-tint px-2.5 py-2">
                <dt className="text-small font-semibold text-cg-muted-strong">Proposed · {entry.authorLabel}</dt>
                <dd className="text-cg-ink">{entry.text}</dd>
                {entry.why ? <dd className="mt-1 text-small text-cg-muted-strong">Why: {entry.why}</dd> : null}
              </div>
            </dl>
          ) : null}

          {need.kind === "collision" ? (
            <div className="flex flex-col gap-1">
              <p className="font-mono text-small text-cg-ink">{need.detail}</p>
              {row ? (
                <ul className="text-small text-cg-muted-strong">
                  {row.touchers
                    .filter((toucher) => toucher.clash)
                    .map((toucher) => (
                      <li key={toucher.sessionId}>
                        {nameOf(toucher.sessionId)}
                        {toucher.ranges.length > 0 ? ` · ${rangesText(toucher.ranges)}` : toucher.change === "deleted" ? " · deleted it" : ""}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {need.kind === "approval" ? <p className="text-ui text-cg-muted-strong">{need.detail}</p> : null}

          {answering && need.entryId ? (
            <ReplyBox
              label="Your answer"
              placeholder="Goes to the agent that asked, and to it only."
              submit="Send answer"
              onCancel={() => setAnswering(false)}
              onSend={async (text) => {
                await onAnswer(need.entryId!, text);
                setAnswering(false);
              }}
            />
          ) : (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {need.kind === "question" && need.entryId ? (
                <>
                  <Button size="sm" variant="primary" onClick={() => setAnswering(true)}>
                    Answer
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => void onResolve(need.entryId!, "dismiss")}>
                    Set aside
                  </Button>
                </>
              ) : null}
              {need.kind === "disagreement" && need.entryId ? (
                <>
                  <Button size="sm" variant="primary" onClick={() => void onResolve(need.entryId!, "adopt")}>
                    Adopt the proposal
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => void onResolve(need.entryId!, "dismiss")}>
                    Keep what stands
                  </Button>
                </>
              ) : null}
              {need.kind === "collision" ? (
                told ? (
                  <span className="text-small text-cg-muted-strong">Told them. They settle it on the board.</span>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => void tellThem()}>
                    Tell them to settle it
                  </Button>
                )
              ) : null}
              {need.kind === "approval" && need.sessionIds[0] ? (
                <Button size="sm" variant="secondary" onClick={() => onOpenChat(need.sessionIds[0]!)}>
                  Open its chat
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}
