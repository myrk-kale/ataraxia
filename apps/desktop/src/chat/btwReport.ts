export type BtwReportEntry = { asked: string; kind: string; summary: string };

const HEADER = /^\[BTW report[^\]]*\]\s*/;
const ENTRY = /^\d+\.\s+Asked \(([^)]*)\):\s*([^\n]*)\n?([\s\S]*)$/;

/**
 * The note the app sends the main agent when a BTW finishes arrives as a user message. It is not
 * something the developer typed, so it is shown as a report, without the instruction in it.
 * Returns null for anything else.
 */
export function parseBtwReport(text: string): BtwReportEntry[] | null {
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
