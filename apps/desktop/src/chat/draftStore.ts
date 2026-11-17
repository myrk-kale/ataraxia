/** Text typed in a chat's composer and not sent: kept per chat so leaving the chat or the app loses nothing. */
const PREFIX = "ataraxia.draft.";

export function loadDraft(chatId: string): string {
  try {
    return window.localStorage.getItem(PREFIX + chatId) ?? "";
  } catch {
    return "";
  }
}

/** An empty draft is not stored: sending a message leaves nothing behind. */
export function saveDraft(chatId: string, text: string): void {
  try {
    if (text === "") {
      window.localStorage.removeItem(PREFIX + chatId);
    } else {
      window.localStorage.setItem(PREFIX + chatId, text);
    }
  } catch {
    // Storage can be full or unavailable; the draft then lives only as long as the window.
  }
}

export function forgetDraft(chatId: string): void {
  saveDraft(chatId, "");
}
