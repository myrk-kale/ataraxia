import { CornerDownRight } from "lucide-react";
import { useState } from "react";
import type { EntryView, MemberView } from "../lib/workbench";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { addresseeOf, ageOf, badgeOf, isHistory, minutesLeft } from "./model";
import { AnchorChip, Author, KindTag, PathChips, ReplyBox, TopicChip, type EntryActions } from "./parts";

/**
 * What was said on the board, newest first. A row says who wrote it, what kind it is, what it is
 * about and where in the code; an answer quotes the question it answers, so a reply is read in
 * its place in the stream and not hidden under an old entry.
 */
export function Timeline({
  entries,
  byId,
  members,
  seenSeq,
  now,
  actions,
}: {
  entries: readonly EntryView[];
  byId: ReadonlyMap<string, EntryView>;
  members: readonly MemberView[];
  /** Entries newer than this are marked new. */
  seenSeq: number;
  now: number;
  actions: EntryActions;
}) {
  return (
    <ol aria-label="Entries, newest first" className="mx-auto flex w-full max-w-[880px] flex-col px-3 py-2">
      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          actions={actions}
          entry={entry}
          isNew={entry.seq > seenSeq && entry.author !== null}
          members={members}
          now={now}
          parent={entry.replyTo ? (byId.get(entry.replyTo) ?? null) : null}
        />
      ))}
    </ol>
  );
}

const QUIET_ACTION =
  "rounded-cg-sm px-2 py-0.5 text-small text-cg-muted-strong hover:bg-cg-line hover:text-cg-ink";

function EntryRow({
  entry,
  parent,
  members,
  isNew,
  now,
  actions,
}: {
  entry: EntryView;
  parent: EntryView | null;
  members: readonly MemberView[];
  isNew: boolean;
  now: number;
  actions: EntryActions;
}) {
  const [replying, setReplying] = useState(false);
  const history = isHistory(entry);
  const badge = badgeOf(entry);
  const to = addresseeOf(entry);
  const left = entry.kind === "claim" && entry.live ? minutesLeft(entry.expiresAt, now) : null;
  const byAgent = entry.author !== null;
  const asksYou = entry.kind === "question" && entry.state === "active" && entry.to === "developer";
  const proposal = entry.state === "contested";
  const canReply = byAgent && entry.kind !== "claim" && !asksYou;
  const retire = entry.live && (entry.kind === "claim" || (entry.kind === "directive" && entry.state === "active"));

  return (
    <li
      className={`group relative flex gap-3 px-3 py-3 ${
        entry.kind === "directive"
          ? "my-1 rounded-cg-md border border-cg-line-strong bg-cg-tint"
          : `border-b border-cg-line ${isNew ? "bg-cg-tint" : ""}`
      }`}
    >
      {isNew ? <span aria-hidden="true" className="absolute top-3 bottom-3 left-0 w-0.5 rounded-full bg-cg-ink" /> : null}
      <Author entry={entry} members={members} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-ui font-semibold text-cg-ink">{byAgent ? entry.authorLabel : "You"}</span>
          <KindTag kind={entry.kind} />
          {entry.topic ? <TopicChip topic={entry.topic} onPick={actions.onPickTopic} /> : null}
          {to ? <span className="text-small text-cg-muted">to {to}</span> : null}
          {badge ? <Chip tone={badge.tone === "attention" ? "attention" : "neutral"}>{badge.label}</Chip> : null}
          {isNew ? <span className="text-small font-medium text-cg-muted-strong">New</span> : null}
          <span className="ml-auto flex items-center gap-1">
            {!replying && (canReply || retire) ? (
              <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                {canReply ? (
                  <button aria-label={`Reply to ${entry.authorLabel}`} className={QUIET_ACTION} type="button" onClick={() => setReplying(true)}>
                    Reply
                  </button>
                ) : null}
                {retire ? (
                  <button
                    className={QUIET_ACTION}
                    type="button"
                    onClick={() => void actions.onResolve(entry.id, "release")}
                  >
                    {entry.kind === "claim" ? "Release" : "Withdraw"}
                  </button>
                ) : null}
              </span>
            ) : null}
            <time
              className="px-1 text-small whitespace-nowrap text-cg-muted"
              dateTime={entry.createdAt}
              title={new Date(entry.createdAt).toLocaleString()}
            >
              {ageOf(entry.createdAt, now)}
            </time>
          </span>
        </div>

        {parent ? (
          <p className="mt-1 flex items-center gap-1.5 text-small text-cg-muted">
            <CornerDownRight aria-hidden="true" className="flex-none" size={12} />
            <span className="truncate">
              Replying to {parent.author === null ? "you" : parent.authorLabel}: “{parent.text}”
            </span>
          </p>
        ) : null}

        <p className={`mt-1 text-ui leading-6 whitespace-pre-wrap ${history ? "text-cg-muted-strong" : "text-cg-ink"}`}>{entry.text}</p>
        {entry.why ? <p className="mt-1 text-small leading-5 text-cg-muted-strong">Why: {entry.why}</p> : null}

        {entry.anchor || entry.paths.length > 0 || left !== null ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {entry.anchor ? <AnchorChip anchor={entry.anchor} onOpenFile={actions.onOpenFile} /> : null}
            {entry.paths.length > 0 ? <PathChips paths={entry.paths} /> : null}
            {left !== null ? <span className="text-small text-cg-muted">About {left} min left</span> : null}
          </div>
        ) : null}

        {proposal ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="primary" onClick={() => void actions.onResolve(entry.id, "adopt")}>
              Adopt this
            </Button>
            <Button size="sm" variant="quiet" onClick={() => void actions.onResolve(entry.id, "dismiss")}>
              Keep the current one
            </Button>
          </div>
        ) : null}
        {asksYou && !replying ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="primary" onClick={() => setReplying(true)}>
              Answer
            </Button>
            <Button size="sm" variant="quiet" onClick={() => void actions.onResolve(entry.id, "dismiss")}>
              Set aside
            </Button>
          </div>
        ) : null}
        {replying ? (
          <ReplyBox
            label={`Your answer to ${entry.authorLabel}`}
            placeholder={`Goes to ${entry.authorLabel}, and to them only.`}
            submit="Send"
            onCancel={() => setReplying(false)}
            onSend={async (text) => {
              await actions.onReply(entry.id, text);
              setReplying(false);
            }}
          />
        ) : null}
      </div>
    </li>
  );
}
