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

/**
 * Text typed in a chat made with + that was left before its first message. That chat is deleted,
 * since it never became one; its text waits here for the next +.
 */
const NEW_CHAT_KEY = "ataraxia.draft.newChat";

export function keepNewChatText(text: string): void {
  if (text.trim() === "") {
    return;
  }
  try {
    window.localStorage.setItem(NEW_CHAT_KEY, text);
  } catch {
    // Storage can be full or unavailable; the text is then lost with the chat, as before.
  }
}

/** The text kept for the next chat made with +, removed as it is taken. */
export function takeNewChatText(): string {
  try {
    const text = window.localStorage.getItem(NEW_CHAT_KEY) ?? "";
    window.localStorage.removeItem(NEW_CHAT_KEY);
    return text;
  } catch {
    return "";
  }
}
