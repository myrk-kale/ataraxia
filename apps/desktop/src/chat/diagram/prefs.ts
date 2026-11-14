import { useSyncExternalStore } from "react";
import { EFFECTS, type EffectId } from "./effects";
import { STYLE_NAMES, type StyleName } from "./glyphs";

/** How diagrams in the chat are drawn and animated. */
export interface DiagramPrefs {
  /** The animation played once when a diagram comes into view; `none` leaves it still. */
  effect: EffectId | "none";
  /** Keep the animation going while the diagram is on screen, instead of once. */
  loop: boolean;
  /** The pieces the lines and boxes are drawn with. */
  style: StyleName;
}

// Data flow, repeated: packets keep travelling along the links while the diagram is on screen.
// Drawing the diagram in over and over would only flash.
export const DEFAULT_PREFS: DiagramPrefs = { effect: "flow", loop: true, style: "unicode" };

const KEY = "ataraxia.diagram";

/** Reads stored settings, keeping each one that is valid and defaulting the rest. */
export function parsePrefs(raw: string | null): DiagramPrefs {
  let value: unknown = null;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  const given = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const effect = given.effect;
  const style = given.style;
  return {
    effect: effect === "none" || EFFECTS.includes(effect as EffectId) ? (effect as DiagramPrefs["effect"]) : DEFAULT_PREFS.effect,
    loop: typeof given.loop === "boolean" ? given.loop : DEFAULT_PREFS.loop,
    style: STYLE_NAMES.includes(style as StyleName) ? (style as StyleName) : DEFAULT_PREFS.style,
  };
}

function load(): DiagramPrefs {
  try {
    return parsePrefs(window.localStorage.getItem(KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

let current: DiagramPrefs | null = null;
const listeners = new Set<() => void>();

const read = (): DiagramPrefs => (current ??= load());

export function setDiagramPrefs(change: Partial<DiagramPrefs>) {
  const next = parsePrefs(JSON.stringify({ ...read(), ...change }));
  current = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Without storage the choice lasts until the window closes.
  }
  listeners.forEach((listener) => listener());
}

/** Forgets what was read, so the next read comes from storage again (for tests). */
export function resetDiagramPrefs() {
  current = null;
  listeners.forEach((listener) => listener());
}

export function useDiagramPrefs(): DiagramPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read,
  );
}
