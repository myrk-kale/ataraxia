import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { estimateRow, type Row } from "./rows";
import { TranscriptRow } from "./TranscriptRow";

/** Rows kept ready past each edge of the window, so ordinary scrolling never shows a gap. */
const OVERSCAN = 4;

/**
 * The transcript as a window onto its rows. Only the rows on screen (and a few either side) are
 * in the page; the rest are space. So a long chat costs what one screen costs, in memory and in
 * the work of laying out, painting and keeping its text up to date, however many messages it
 * has. Each row's real height is measured when it is shown and kept, so the space left for it
 * is right the next time.
 *
 * It sits inside the scroll area it is given. While `stick` is set it keeps the scroll at the
 * bottom as the last row grows.
 */
export function VirtualTranscript({
  rows,
  scrollRef,
  stick,
  sessionId,
}: {
  rows: Row[];
  scrollRef: RefObject<HTMLDivElement | null>;
  stick: RefObject<boolean>;
  sessionId: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // How far down the scroll area this list starts, below whatever is above it.
  const [margin, setMargin] = useState(0);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateRow(rows[index]),
    getItemKey: (index) => rows[index].key,
    overscan: OVERSCAN,
    scrollMargin: margin,
  });

  useLayoutEffect(() => {
    const top = listRef.current?.offsetTop ?? 0;
    setMargin((current) => (current === top ? current : top));
  });

  const total = virtualizer.getTotalSize();
  // A row grew (the reply is streaming, a picture loaded): stay at the bottom if that is where
  // the reader is.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stick.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [total, scrollRef, stick]);

  return (
    <div ref={listRef} className="relative w-full" style={{ height: total }}>
      {virtualizer.getVirtualItems().map((virtual) => {
        const row = rows[virtual.index];
        return (
          <div
            key={virtual.key}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 flex w-full flex-col"
            data-index={virtual.index}
            style={{
              paddingBottom: row.after,
              transform: `translateY(${virtual.start - margin}px)`,
            }}
          >
            <TranscriptRow row={row} sessionId={sessionId} />
          </div>
        );
      })}
    </div>
  );
}
