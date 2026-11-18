/**
 * Chats made with + that have not had a message yet. They exist so the composer, the model and
 * the effort work as in any chat, but they are not chats yet: the chat list leaves them out, and
 * one left without a message is deleted when another chat takes its place. The first message
 * makes it a chat for good.
 */
const KEY = "ataraxia.draftChats";

function read(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function write(ids: readonly string[]): void {
  try {
    if (ids.length === 0) {
      window.localStorage.removeItem(KEY);
    } else {
      window.localStorage.setItem(KEY, JSON.stringify(ids));
    }
  } catch {
    // Storage can be unavailable; the chat then simply stays, as before.
  }
}

export function draftChats(): ReadonlySet<string> {
  return new Set(read());
}

export function markDraftChat(id: string): void {
  const ids = read();
  if (!ids.includes(id)) {
    write([...ids, id]);
  }
}

/** The chat got its first message, or was deleted: it is no longer a draft. */
export function settleDraftChat(id: string): void {
  const ids = read();
  if (ids.includes(id)) {
    write(ids.filter((item) => item !== id));
  }
}

export function isDraftChat(id: string): boolean {
  return read().includes(id);
}

/** Notifies the shell that a draft became a real chat, so the chat list shows it. */
export const DRAFT_SETTLED_EVENT = "ataraxia:draft-settled";

export function announceSettled(id: string): void {
  if (!isDraftChat(id)) {
    return;
  }
  settleDraftChat(id);
  window.dispatchEvent(new CustomEvent(DRAFT_SETTLED_EVENT, { detail: id }));
}
