import { useSyncExternalStore } from "react";

/**
 * Whether the animated background (the ASCII A and the drifting field behind the chat) is shown.
 * On by default and switched off in Settings, one choice for the whole app. It is a preference of
 * this computer, so it is kept in the browser storage and never leaves it.
 */
const KEY = "ataraxia.background";

/** The stored value, which may be missing or hand-edited, as a choice. Anything but `off` is on. */
export function normalizeBackground(value: unknown): boolean {
  return value !== "off" && value !== false;
}

function read(): boolean {
  try {
    return normalizeBackground(window.localStorage.getItem(KEY));
  } catch {
    return true;
  }
}

let enabled = read();
const listeners = new Set<() => void>();

export function setBackground(on: boolean) {
  enabled = on;
  try {
    window.localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Not remembering the choice is harmless.
  }
  listeners.forEach((listener) => listener());
}

export function useBackground(): { enabled: boolean; set: (on: boolean) => void } {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => enabled,
    () => true,
  );
  return { enabled: current, set: setBackground };
}
