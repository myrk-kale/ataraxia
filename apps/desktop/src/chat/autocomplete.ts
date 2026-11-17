import { useEffect, useState } from "react";
import { autocompleteSuggest, type AutocompleteSuggestion } from "../lib/agent";
import type { SessionId } from "../lib/workspace";

/** Time given to a burst of typing before the suggestion is asked for. */
const WAIT_MS = 40;

type Known = { draft: string; suggestion: AutocompleteSuggestion | null };

/**
 * The suggestion that still holds once more has been typed: typing what it suggested shortens it
 * instead of making it vanish until the next answer arrives.
 */
export function advance(known: Known | null, draft: string): AutocompleteSuggestion | null {
  if (!known?.suggestion) {
    return null;
  }
  if (draft === known.draft) {
    return known.suggestion;
  }
  if (draft.length > known.draft.length && draft.startsWith(known.draft)) {
    const typed = draft.slice(known.draft.length);
    const { text } = known.suggestion;
    if (text.length > typed.length && text.startsWith(typed)) {
      return { ...known.suggestion, text: text.slice(typed.length) };
    }
  }
  return null;
}

/**
 * What the app suggests after `draft`, learned from what has been written and from the names in
 * the code. The work happens in the app; this asks, and drops an answer that arrives late.
 */
export function useSuggestion(sessionId: SessionId, draft: string, active: boolean): AutocompleteSuggestion | null {
  const [known, setKnown] = useState<Known | null>(null);

  useEffect(() => {
    if (!active || draft.trim() === "") {
      return;
    }
    let stale = false;
    const timer = window.setTimeout(() => {
      autocompleteSuggest(sessionId, draft).then(
        (suggestion) => {
          if (!stale) {
            setKnown({ draft, suggestion });
          }
        },
        () => {
          if (!stale) {
            setKnown(null);
          }
        },
      );
    }, WAIT_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [sessionId, draft, active]);

  return active ? advance(known, draft) : null;
}
