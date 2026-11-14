import type { ChatItem } from "../lib/agent";
import { toBlocks } from "./blocks";

/** The space between two things said by the same side of the conversation, and between turns. */
export const GROUP_GAP = 12;
export const TURN_GAP = 38;

/**
 * One thing in the transcript: a message or a tool call. The list is cut here, not by turn,
 * because one turn of the agent can run to dozens of tool calls and screens of text.
 */
export type Row = {
  key: string;
  item: ChatItem;
  /** Space below it, so a row's own height carries its share of the gap. */
  after: number;
  /** The divider "earlier messages are shown for reference" goes above this one. */
  notice: boolean;
};

/**
 * The rows of a transcript. `restoredSplit` is the index of the first item the running agent
 * process produced (the notice goes before it), or -1 when there is no split.
 */
export function toRows(items: ChatItem[], restoredSplit: number): Row[] {
  const rows: Row[] = [];
  let seen = 0;
  for (const block of toBlocks(items, restoredSplit)) {
    const members = block.kind === "agent" ? block.items : [block.item];
    const notice = restoredSplit > 0 && seen === restoredSplit;
    seen += members.length;
    members.forEach((item, at) => {
      rows.push({
        key: item.kind === "tool" ? item.callId : item.id,
        item,
        after: at === members.length - 1 ? TURN_GAP : GROUP_GAP,
        notice: notice && at === 0,
      });
    });
  }
  if (rows.length > 0) {
    rows[rows.length - 1] = { ...rows[rows.length - 1], after: 0 };
  }
  return rows;
}

// Measured on the real rendering (the chat's text size, a 680 px reply column).
const TEXT_LINE = 24.7;
const CODE_LINE = 23.4;
const TABLE_ROW = 29;
const BLOCK_PADDING = 40;
const PARAGRAPH_GAP = 14;
const DIAGRAM = 200;
const REPLY_CHARS = 105;
const BUBBLE_CHARS = 68;

function wrapped(length: number, perLine: number): number {
  return Math.max(1, Math.ceil(length / perLine));
}

/** Roughly how tall rendered markdown is: text by its wrapped lines, code and tables by theirs. */
function markdownHeight(text: string, perLine: number): number {
  let height = 0;
  let fence: "code" | "diagram" | null = null;
  let inParagraph = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      if (fence === null) {
        fence = line.slice(3).trim() === "mermaid" ? "diagram" : "code";
        height += fence === "diagram" ? DIAGRAM : BLOCK_PADDING;
      } else {
        fence = null;
      }
      inParagraph = false;
      continue;
    }
    if (fence === "diagram") {
      continue;
    }
    if (fence === "code") {
      height += CODE_LINE;
      continue;
    }
    if (line.trim() === "") {
      inParagraph = false;
      continue;
    }
    if (line.startsWith("|")) {
      height += TABLE_ROW;
      inParagraph = false;
      continue;
    }
    // Margins between blocks do not stack, and the first and last have none.
    height += wrapped(line.length, perLine) * TEXT_LINE + (inParagraph || height === 0 ? 0 : PARAGRAPH_GAP);
    inParagraph = true;
  }
  return height;
}

/**
 * A guess at a row's height before it has been on screen. It only has to be near: the real
 * height replaces it the first time the row is drawn, and the nearer it is the less the page
 * moves under a reader who scrolls fast.
 */
export function estimateRow(row: Row): number {
  const { item } = row;
  let height: number;
  if (item.kind === "tool") {
    height = 38;
  } else if (item.role === "user") {
    const lines = item.text
      .split("\n")
      .reduce((total, line) => total + wrapped(line.length, BUBBLE_CHARS), 0);
    height = 31 + lines * TEXT_LINE + (item.images && item.images.length > 0 ? 140 : 0);
  } else {
    height = markdownHeight(item.text, REPLY_CHARS);
  }
  return height + (row.notice ? 60 : 0) + row.after;
}
