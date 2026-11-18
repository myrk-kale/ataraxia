/**
 * The subagents a chat's view hid, kept per chat so leaving the chat (another space, another chat,
 * a restart) does not bring them back. Their saved conversations are untouched.
 */
const PREFIX = "ataraxia.closedSubagents.";
/** Enough for any real chat; the oldest are dropped first. */
const MAX_IDS = 200;

export function loadClosedSubagents(chatId: string): Set<string> {
  try {
    const stored = window.localStorage.getItem(PREFIX + chatId);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveClosedSubagents(chatId: string, ids: ReadonlySet<string>): void {
  try {
    if (ids.size === 0) {
      window.localStorage.removeItem(PREFIX + chatId);
      return;
    }
    window.localStorage.setItem(PREFIX + chatId, JSON.stringify([...ids].slice(-MAX_IDS)));
  } catch {
    // Storage can be full or unavailable; the chips then stay hidden only while the chat is open.
  }
}

export function forgetClosedSubagents(chatId: string): void {
  saveClosedSubagents(chatId, new Set());
}
