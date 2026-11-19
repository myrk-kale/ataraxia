import type { ChatItem } from "../lib/agent";
import type { Decision } from "../lib/insights";
import { toBlocks } from "./blocks";

/** The space between two things said by the same side of the conversation, and between turns. */
export const GROUP_GAP = 12;
export const TURN_GAP = 38;

/**
 * One thing in the transcript: a message or a tool call. The list is cut here, not by turn,
 * because one turn of the agent can run to dozens of tool calls and screens of text.
 */
export type MessageRow = {
  key: string;
  item: ChatItem;
  /** Space below it, so a row's own height carries its share of the gap. */
  after: number;
  /** The divider "earlier messages are shown for reference" goes above this one. */
  notice: boolean;
  copyText?: string;
};

export type DecisionRow = {
  key: string;
  decisions: readonly Decision[];
  after: number;
};

export type Row = MessageRow | DecisionRow;

/**
 * The rows of a transcript. `restoredSplit` is the index of the first item the running agent
 * process produced (the notice goes before it), or -1 when there is no split.
 */
export function toRows(items: ChatItem[], restoredSplit: number): MessageRow[] {
  const rows: MessageRow[] = [];
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
  const isUser = (row: MessageRow) => row.item.kind === "message" && row.item.role === "user";
  let start = 0;
  while (start < rows.length) {
    if (isUser(rows[start])) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < rows.length && !isUser(rows[end])) end += 1;
    const messages = rows.slice(start, end).filter((row) => row.item.kind === "message" && (row.item.role === "assistant" || row.item.role === "reasoning") && row.item.text.trim());
    const last = messages.at(-1);
    if (last) {
      last.copyText = messages.map((row) => row.item.kind === "message" ? row.item.text : "").join("\n\n");
    }
    start = end;
  }
  if (rows.length > 0) {
    rows[rows.length - 1] = { ...rows[rows.length - 1], after: 0 };
  }
  return rows;
}

/** Place decisions after the last message or tool in their originating turn. */
export function withDecisionRows(
  rows: MessageRow[],
  decisions: readonly Decision[],
  showActivity: boolean,
): Row[] {
  if (decisions.length === 0 && !showActivity) return rows;

  const lastInTurn = new Map<string, number>();
  const firstReport = new Map<number, number>();
  for (const [index, { item }] of rows.entries()) {
    if (item.turnId) lastInTurn.set(item.turnId, index);
    if (item.kind !== "message" || item.role !== "user" || !item.text.startsWith("[Decision review, sent by Ataraxia when ")) {
      continue;
    }
    // Older decisions lack a turn ID. Their first review report still places them before the verdict.
    for (const match of item.text.matchAll(/^- (?:Approved )?#(\d+)(?=[: ])/gm)) {
      const seq = Number(match[1]);
      if (!firstReport.has(seq)) firstReport.set(seq, index);
    }
  }

  const groups = new Map<number, Decision[]>();
  for (const decision of decisions) {
    if (decision.state === "superseded") continue;
    const origin = decision.turn_id ? lastInTurn.get(decision.turn_id) : undefined;
    const beforeReport = firstReport.get(decision.seq);
    const slot = origin !== undefined ? origin + 1 : beforeReport ?? rows.length;
    const group = groups.get(slot);
    if (group) group.push(decision);
    else groups.set(slot, [decision]);
  }
  const transcript: Row[] = [];
  for (let slot = 0; slot <= rows.length; slot += 1) {
    const group = groups.get(slot);
    if (group) {
      const prior = transcript.at(-1);
      if (prior) transcript[transcript.length - 1] = { ...prior, after: GROUP_GAP };
      transcript.push({
        key: `decisions:${group[0].turn_id ?? group[0].id}`,
        decisions: group,
        after: slot < rows.length ? TURN_GAP : 0,
      });
    }
    if (slot < rows.length) transcript.push(rows[slot]);
  }
  if (showActivity && !groups.has(rows.length)) {
    const prior = transcript.at(-1);
    if (prior) transcript[transcript.length - 1] = { ...prior, after: GROUP_GAP };
    transcript.push({ key: "decisions:activity", decisions: [], after: 0 });
  }
  return transcript;
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
        const language = line.slice(3).trim();
        fence = language === "mermaid" || language === "svg" ? "diagram" : "code";
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
  if ("decisions" in row) return 38 + row.after;
  const { item } = row;
  let height: number;
  if (item.kind === "tool") {
    height = 38;
  } else if (item.role === "system") {
    height = 24;
  } else if (item.role === "reasoning") {
    height = 24 + item.text.split("\n").reduce((total, line) => total + wrapped(line.length, REPLY_CHARS), 0) * TEXT_LINE;
  } else if (item.role === "user") {
    const lines = item.text
      .split("\n")
      .reduce((total, line) => total + wrapped(line.length, BUBBLE_CHARS), 0);
    height = 31 + lines * TEXT_LINE + (item.images && item.images.length > 0 ? 140 : 0);
  } else {
    height = markdownHeight(item.text, REPLY_CHARS);
  }
  return height + (row.copyText ? 36 : 0) + (row.notice ? 60 : 0) + row.after;
}
