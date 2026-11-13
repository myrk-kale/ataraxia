/** Typeface and size for each area of the app. A blank family means the app's own typeface. */

export type FontArea = "interface" | "chat" | "code" | "terminal";

export type FontSetting = { family: string; size: number };
export type FontSettings = Record<FontArea, FontSetting>;

export const AREAS: readonly { id: FontArea; label: string; hint: string }[] = [
  { id: "interface", label: "Interface", hint: "Menus, buttons, lists and dialogs. The whole layout scales with it." },
  { id: "chat", label: "Chat and reading", hint: "Messages, decisions and long text." },
  { id: "code", label: "Code", hint: "The editor and viewer, diffs and code in messages." },
  { id: "terminal", label: "Terminal", hint: "The integrated terminal." },
];

export const SIZE_LIMITS: Record<FontArea, { min: number; max: number; default: number }> = {
  interface: { min: 11, max: 18, default: 13 },
  chat: { min: 12, max: 22, default: 14.5 },
  code: { min: 10, max: 28, default: 12.5 },
  terminal: { min: 10, max: 24, default: 13 },
};

export const DEFAULT_FONTS: FontSettings = {
  interface: { family: "", size: SIZE_LIMITS.interface.default },
  chat: { family: "", size: SIZE_LIMITS.chat.default },
  code: { family: "", size: SIZE_LIMITS.code.default },
  terminal: { family: "", size: SIZE_LIMITS.terminal.default },
};

/** What each area falls back to, after the chosen family: the bundled typeface, then the system's. */
export const FALLBACK_STACKS: Record<FontArea, string> = {
  interface: '"Geist Variable", Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, system-ui, sans-serif',
  chat: '"Geist Variable", Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, system-ui, sans-serif',
  code: '"Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  terminal:
    '"Geist Mono Variable", "MesloLGS NF", "JetBrainsMono Nerd Font", "FiraCode Nerd Font", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
};

const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded"]);

/**
 * A list of typeface names as safe CSS: letters, digits and a few separators, each name with a
 * space quoted. Anything that could end the declaration or open a function is dropped.
 */
export function cleanFamily(text: string): string {
  return text
    .split(",")
    .map((part) => part.replace(/["']/g, "").replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((name) => (GENERIC.has(name.toLowerCase()) || !/\s/.test(name) ? name : `"${name}"`))
    .join(", ")
    .slice(0, 160);
}

/** The CSS `font-family` for an area: the chosen faces first, then the area's own fallbacks. */
export function familyFor(area: FontArea, setting: FontSetting): string {
  const chosen = cleanFamily(setting.family);
  return chosen ? `${chosen}, ${FALLBACK_STACKS[area]}` : FALLBACK_STACKS[area];
}

export function clampSize(area: FontArea, size: number): number {
  const { min, max, default: fallback } = SIZE_LIMITS[area];
  if (!Number.isFinite(size)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(size * 2) / 2));
}

/** Settings as stored, which may be missing, old or hand-edited, made whole and in range. */
export function normalizeFonts(value: unknown): FontSettings {
  const stored = value && typeof value === "object" ? (value as Partial<Record<FontArea, Partial<FontSetting>>>) : {};
  const out = {} as FontSettings;
  for (const { id } of AREAS) {
    const item = stored[id];
    out[id] = {
      family: typeof item?.family === "string" ? cleanFamily(item.family) : "",
      size: clampSize(id, typeof item?.size === "number" ? item.size : SIZE_LIMITS[id].default),
    };
  }
  return out;
}

/** The CSS variables that carry the settings; the stylesheet reads these. */
export function fontVars(fonts: FontSettings): Record<string, string> {
  return {
    "--font-sans": familyFor("interface", fonts.interface),
    "--cg-font-chat": familyFor("chat", fonts.chat),
    "--font-mono": familyFor("code", fonts.code),
    "--cg-ui-scale": String(fonts.interface.size / SIZE_LIMITS.interface.default),
    "--cg-chat-size": `${fonts.chat.size}px`,
  };
}
