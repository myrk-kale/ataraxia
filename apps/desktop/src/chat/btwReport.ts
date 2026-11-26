export type BtwReportEntry = { asked: string; kind: string; summary: string };

const HEADER = /^\[BTW report[^\]]*\]\s*/;
const ENTRY = /^\d+\.\s+Asked \(([^)]*)\):\s*([^\n]*)\n?([\s\S]*)$/;
const UPDATE_HEADER = /^\[BTW subagent update[^\]]*\]\s*/;
// What the main agent is told to do with the update: today to say it understood and wait for the
// developer, earlier to ask before acting. Both are hidden, so chats from before still read well.
const UPDATE_INSTRUCTIONS =
  /\n(?:Reply only with a short acknowledgement that you understood[^\n]*(?:\n[^\n]*)*|If the reply suggests a change or any other action, ask the developer what they want before acting on it\.)$/;

/**
 * Automatic BTW updates arrive as user messages. They are not text the developer typed, so they
 * are shown as a report with the handoff instruction hidden.
 * Returns null for anything else.
 */
export function parseBtwReport(text: string): BtwReportEntry[] | null {
  if (UPDATE_HEADER.test(text)) {
    const body = text.replace(UPDATE_HEADER, "");
    const replyMarker = "\nBTW replied: ";
    const replyAt = body.indexOf(replyMarker);
    const questionPrefix = "Developer asked: ";
    const questionAt = body.indexOf(questionPrefix);
    if (questionAt !== 0 || replyAt < questionPrefix.length) {
      return [];
    }
    const question = body.slice(questionPrefix.length, replyAt).trim();
    const summary = body.slice(replyAt + replyMarker.length).replace(UPDATE_INSTRUCTIONS, "").trim();
    return [{ kind: "parallel BTW conversation", asked: question, summary }];
  }
  if (!HEADER.test(text)) {
    return null;
  }
  const body = text.replace(HEADER, "");
  const entries = body
    .split(/\n(?=\d+\.\s+Asked \()/)
    .map((part) => ENTRY.exec(part.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      kind: match[1] ?? "",
      asked: (match[2] ?? "").trim(),
      summary: (match[3] ?? "").trim(),
    }));
  return entries.length > 0 ? entries : [];
}
