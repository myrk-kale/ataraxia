import { CircleAlert, CircleCheck, Lock } from "lucide-react";
import type { EntryView, MemberView, Resolution, TopicView } from "../lib/workbench";
import { Button } from "../ui/Button";
import { ageOf, minutesLeft } from "./model";
import { AnchorChip, Author, type EntryActions } from "./parts";

/**
 * What the agents agreed, by topic: the decision that stands, who made it and why, what is proposed
 * against it, who holds the topic and what is still asked. It is the contract nobody wrote up
 * beforehand, and it can be copied out as Markdown.
 */
export function Topics({
  topics,
  members,
  now,
  actions,
}: {
  topics: readonly TopicView[];
  members: readonly MemberView[];
  now: number;
  actions: EntryActions;
}) {
  if (topics.length === 0) {
    return (
      <p className="mx-auto max-w-[560px] px-6 py-10 text-center text-ui leading-6 text-cg-muted">
        Nothing is decided yet. When an agent settles something others will rely on (a type, an API shape, a file layout) it posts it
        here under a topic, and the first decision on a topic stands.
      </p>
    );
  }
  return (
    <ul className="mx-auto flex w-full max-w-[880px] flex-col gap-3 px-6 py-4">
      {topics.map((topic) => (
        <TopicCard key={topic.topic.toLowerCase()} actions={actions} members={members} now={now} topic={topic} />
      ))}
    </ul>
  );
}

function Standing({ entry, members, now, actions }: { entry: EntryView; members: readonly MemberView[]; now: number; actions: EntryActions }) {
  return (
    <div className="flex gap-2.5">
      <Author entry={entry} members={members} size={22} />
      <div className="min-w-0 flex-1">
        <p className="text-ui leading-6 whitespace-pre-wrap text-cg-ink">{entry.text}</p>
        <p className="mt-0.5 text-small text-cg-muted">
          {entry.author === null ? "You" : entry.authorLabel} · {ageOf(entry.updatedAt, now)}
        </p>
        {entry.why ? <p className="mt-1 text-small leading-5 text-cg-muted-strong">Why: {entry.why}</p> : null}
        {entry.anchor ? (
          <div className="mt-1.5">
            <AnchorChip anchor={entry.anchor} onOpenFile={actions.onOpenFile} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TopicCard({ topic, members, now, actions }: { topic: TopicView; members: readonly MemberView[]; now: number; actions: EntryActions }) {
  const disputed = topic.proposals.length > 0;
  const resolve = (id: string, resolution: Resolution) => void actions.onResolve(id, resolution);
  return (
    <li className={`rounded-cg-md border bg-cg-panel ${disputed ? "border-cg-line-strong border-l-2 border-l-cg-amber" : "border-cg-line"}`}>
      <header className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <h3 className="min-w-0 font-mono text-ui font-semibold break-all text-cg-ink">{topic.topic}</h3>
        {disputed ? (
          <span className="inline-flex items-center gap-1 text-small font-medium text-cg-amber-text">
            <CircleAlert aria-hidden="true" size={12} />
            Disputed
          </span>
        ) : topic.standing ? (
          <span className="inline-flex items-center gap-1 text-small font-medium text-cg-green">
            <CircleCheck aria-hidden="true" size={12} />
            Settled
          </span>
        ) : (
          <span className="text-small font-medium text-cg-muted-strong">Not decided</span>
        )}
        {topic.history > 0 ? (
          <span className="ml-auto text-small text-cg-muted">
            {topic.history} earlier {topic.history === 1 ? "decision" : "decisions"}
          </span>
        ) : null}
      </header>

      <div className="flex flex-col gap-3 px-4 pt-2.5 pb-3.5">
        {topic.standing ? <Standing actions={actions} entry={topic.standing} members={members} now={now} /> : null}

        {topic.proposals.map((proposal) => (
          <div key={proposal.id} className="rounded-cg-sm bg-cg-tint px-3 py-2.5">
            <p className="text-small font-semibold text-cg-amber-text">Proposed by {proposal.authorLabel}</p>
            <p className="mt-0.5 text-ui leading-6 whitespace-pre-wrap text-cg-ink">{proposal.text}</p>
            {proposal.why ? <p className="mt-1 text-small text-cg-muted-strong">Why: {proposal.why}</p> : null}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="primary" onClick={() => resolve(proposal.id, "adopt")}>
                Adopt this
              </Button>
              <Button size="sm" variant="quiet" onClick={() => resolve(proposal.id, "dismiss")}>
                Keep the current one
              </Button>
            </div>
          </div>
        ))}

        {topic.heldBy.map((claim) => {
          const left = minutesLeft(claim.expiresAt, now);
          return (
            <p key={claim.id} className="flex items-center gap-1.5 text-small text-cg-muted-strong">
              <Lock aria-hidden="true" className="flex-none" size={12} />
              <span>
                {claim.authorLabel} holds it: {claim.text}
                {left !== null ? ` (about ${left} min left)` : ""}
              </span>
            </p>
          );
        })}
        {topic.openQuestions.map((question) => (
          <p key={question.id} className="text-small text-cg-muted-strong">
            Asked by {question.authorLabel}
            {question.toLabel ? ` to ${question.toLabel}` : ""}: {question.text}
          </p>
        ))}
      </div>
    </li>
  );
}
