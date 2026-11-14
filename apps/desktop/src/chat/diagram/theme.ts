import { useSyncExternalStore } from "react";
import { buildPalette } from "./palette";

let probe: HTMLElement | null = null;

/** A token's colour as the browser resolves it, whatever notation the theme wrote it in. */
function resolve(token: string): string {
  if (!probe) {
    probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
    probe.setAttribute("aria-hidden", "true");
    document.body.appendChild(probe);
  }
  probe.style.color = `var(${token})`;
  return getComputedStyle(probe).color;
}

let version = 0;
let palette: { version: number; colours: Float32Array } | null = null;
const listeners = new Set<() => void>();
let watching = false;

function bump() {
  version += 1;
  listeners.forEach((listener) => listener());
}

function watch() {
  if (watching) {
    return;
  }
  watching = true;
  // The theme and the fonts are set on the root element; a web font arriving changes the letters.
  new MutationObserver(bump).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });
  document.fonts?.addEventListener?.("loadingdone", bump);
}

/** The colour of every class under the theme in force now. */
export function currentPalette(): Float32Array {
  watch();
  if (!palette || palette.version !== version) {
    palette = { version, colours: buildPalette(resolve) };
  }
  return palette.colours;
}

/** The font the letters of a diagram are set in: the code font of the settings. */
export function diagramFont(): string {
  const root = getComputedStyle(document.documentElement);
  return root.getPropertyValue("--font-mono").trim() || "ui-monospace, Menlo, monospace";
}

/** Changes when the theme or a font does, so a drawing made under the old one is made again. */
export function useThemeVersion(): number {
  watch();
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => version,
  );
}

export const themeVersion = (): number => version;
