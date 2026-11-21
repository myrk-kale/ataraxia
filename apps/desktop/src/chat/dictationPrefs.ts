import { useSyncExternalStore } from "react";

/** How the microphone button behaves once it is recording. */
export type DictationPrefs = {
  /** Stop by itself after a quiet moment. Off: it records until the button is pressed again. */
  autoStop: boolean;
  /** How long the quiet lasts before it stops, in milliseconds. Only used with `autoStop`. */
  silenceMs: number;
};

export const MIN_SILENCE_MS = 500;
export const MAX_SILENCE_MS = 5000;
export const SILENCE_STEP_MS = 250;
export const DEFAULT_DICTATION: DictationPrefs = { autoStop: true, silenceMs: 1500 };

const KEY = "ataraxia.dictation";

/** Settings as stored, which may be missing or hand-edited, made whole and in range. */
export function normalizeDictation(value: unknown): DictationPrefs {
  const stored = value && typeof value === "object" ? (value as Partial<DictationPrefs>) : {};
  const silence =
    typeof stored.silenceMs === "number" && Number.isFinite(stored.silenceMs) ? stored.silenceMs : DEFAULT_DICTATION.silenceMs;
  return {
    autoStop: typeof stored.autoStop === "boolean" ? stored.autoStop : DEFAULT_DICTATION.autoStop,
    silenceMs: Math.min(MAX_SILENCE_MS, Math.max(MIN_SILENCE_MS, Math.round(silence / SILENCE_STEP_MS) * SILENCE_STEP_MS)),
  };
}

function load(): DictationPrefs {
  try {
    const text = window.localStorage.getItem(KEY);
    return normalizeDictation(text ? JSON.parse(text) : null);
  } catch {
    return DEFAULT_DICTATION;
  }
}

let current: DictationPrefs | null = null;
const listeners = new Set<() => void>();

/** What is set now; read when a recording starts, so a change applies to the next one. */
export const readDictationPrefs = (): DictationPrefs => (current ??= load());

export function setDictationPrefs(change: Partial<DictationPrefs>) {
  current = normalizeDictation({ ...readDictationPrefs(), ...change });
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Without storage the choice lasts until the window closes.
  }
  listeners.forEach((listener) => listener());
}

/** Forgets what was read, so the next read comes from storage again (for tests). */
export function resetDictationPrefs() {
  current = null;
  listeners.forEach((listener) => listener());
}

export function useDictationPrefs(): DictationPrefs & { set: (change: Partial<DictationPrefs>) => void } {
  const prefs = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readDictationPrefs,
    () => DEFAULT_DICTATION,
  );
  return { ...prefs, set: setDictationPrefs };
}
