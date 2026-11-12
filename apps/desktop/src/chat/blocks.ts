import type { ChatItem, ChatMessage } from "../lib/agent";

export type Block =
  | { kind: "user"; item: ChatMessage; key: string }
  | { kind: "agent"; items: ChatItem[]; key: string };

/** Groups consecutive agent messages and tool calls so the author line shows once per reply. */
export function toBlocks(items: ChatItem[], splitBefore: number): Block[] {
  const blocks: Block[] = [];
  items.forEach((item, index) => {
    if (item.kind === "message" && item.role === "user") {
      blocks.push({ kind: "user", item, key: item.id });
      return;
    }
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "agent" && index !== splitBefore) {
      last.items.push(item);
      return;
    }
    const key = item.kind === "tool" ? item.callId : item.id;
    blocks.push({ kind: "agent", items: [item], key });
  });
  return blocks;
}
