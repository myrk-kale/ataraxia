/**
 * A message taken out of the queue goes back into the message field when the field is empty, so
 * it can be edited or sent again. With something typed there, nothing is overwritten: the
 * message is just removed. Pictures are not kept by the queue's list, so only the words return.
 */
export function takesBack(draft: string, queuedText: string): boolean {
  return queuedText.trim() !== "" && draft.trim() === "";
}

/** The field after the message returns: the typed text wins if something was typed meanwhile. */
export function withTakenBack(current: string, queuedText: string): string {
  return current.trim() === "" ? queuedText : current;
}
