import { memo } from "react";
import type { ChatItem } from "../lib/agent";
import { parseBtwReport } from "./btwReport";
import { Markdown } from "./Markdown";
import { MessageImages } from "./MessageImages";
import type { Row } from "./rows";
import { ToolCard } from "./ToolCard";

const RESTORED_NOTICE = (
  <div
    className="flex items-center gap-3 text-small text-cg-muted"
    role="note"
  >
    <span className="h-px flex-1 bg-cg-line" />
    <span>Earlier messages are shown for reference; the agent starts fresh.</span>
    <span className="h-px flex-1 bg-cg-line" />
  </div>
);

function BtwReport({ text }: { text: string }) {
  const report = parseBtwReport(text);
  if (!report) {
    return null;
  }
  return (
    <section
      aria-label="BTW report"
      className="flex max-w-[680px] min-w-0 flex-col gap-3 rounded-cg-lg border border-cg-line px-5 py-4"
    >
      <h4 className="text-small font-semibold text-cg-muted-strong">BTW finished</h4>
      {report.map((entry, index) => (
        <div key={`${index}:${entry.asked}`} className="flex min-w-0 flex-col gap-1.5">
          <p className="text-ui font-medium break-words text-cg-ink [overflow-wrap:anywhere]">{entry.asked}</p>
          {entry.summary ? (
            <div className="min-w-0 text-body leading-[1.7] break-words [overflow-wrap:anywhere]">
              <Markdown text={entry.summary} />
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function Item({ item, sessionId }: { item: ChatItem; sessionId: string }) {
  if (item.kind === "tool") {
    return (
      <div className="max-w-[680px]">
        <ToolCard tool={item} />
      </div>
    );
  }
  if (item.role === "user") {
    if (parseBtwReport(item.text)) {
      return <BtwReport text={item.text} />;
    }
    return (
      <div className="max-w-[min(80%,600px)] min-w-0 self-end rounded-cg-lg bg-cg-bubble px-5.5 py-4.5 text-body leading-[1.7] break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
        {item.images && item.images.length > 0 ? (
          <MessageImages images={item.images} sessionId={sessionId} />
        ) : null}
        {item.text}
      </div>
    );
  }
  return (
    <div className="max-w-[680px] min-w-0 text-body leading-[1.7] break-words [overflow-wrap:anywhere]">
      <Markdown text={item.text} />
    </div>
  );
}

/**
 * One row of the transcript. A row is drawn again only when its own item changed, so while a
 * reply streams in, the rows above it cost nothing.
 */
export const TranscriptRow = memo(
  function TranscriptRow({ row, sessionId }: { row: Row; sessionId: string }) {
    if (!row.notice) {
      return <Item item={row.item} sessionId={sessionId} />;
    }
    return (
      <div className="flex flex-col gap-9.5">
        {RESTORED_NOTICE}
        <Item item={row.item} sessionId={sessionId} />
      </div>
    );
  },
  (before, after) =>
    before.row.item === after.row.item &&
    before.row.notice === after.row.notice &&
    before.sessionId === after.sessionId,
);
