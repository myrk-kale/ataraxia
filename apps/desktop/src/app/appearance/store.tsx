import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_FONTS, clampSize, cleanFamily, fontVars, normalizeFonts, type FontArea, type FontSettings } from "./fonts";
import { DEFAULT_FAMILY, BUILT_IN_THEMES, builtInTheme, isBuiltInFamily } from "./builtins";
import { importVsCodeTheme, type CustomTheme, type ThemeKind } from "./vscode";

export { BUILT_IN_THEMES };

/** Which variant of a built-in theme is painted: the system's own, or one of the two. */
export type Mode = "system" | "light" | "dark";
const isMode = (value: unknown): value is Mode => value === "system" || value === "light" || value === "dark";

const SETTINGS_KEY = "ataraxia.appearance";
const THEMES_KEY = "ataraxia.themes";
/** What `theme-init.js` applies before the first paint, so the chosen theme and fonts never flash. */
const APPLIED_KEY = "ataraxia.appearance.applied";
const LEGACY_KEY = "ataraxia.theme";
const MAX_THEMES = 24;
const MAX_FILE_BYTES = 2_000_000;

type Chosen = {
  /** A built-in theme (which has a light and a dark variant) or an imported one (which has one). */
  themeId: string;
  mode: Mode;
  /** The built-in theme the header toggle returns to after an imported one. */
  lastFamily: string;
  fonts: FontSettings;
};

const DEFAULT_CHOICE: Chosen = { themeId: DEFAULT_FAMILY, mode: "system", lastFamily: DEFAULT_FAMILY, fonts: DEFAULT_FONTS };

export type ImportResult = { added: CustomTheme[]; errors: string[] };

export type Appearance = {
  /** The theme the person chose: a built-in one or an imported one. */
  themeId: string;
  /** Light, dark or the system's, for a built-in theme. An imported theme has the one mode it was made in. */
  mode: Mode;
  themes: CustomTheme[];
  /** What is painted now. */
  kind: ThemeKind;
  /** The theme painted, when it is not Ataraxia's own (a built-in variant or an imported one). */
  custom: CustomTheme | null;
  /** The imported theme in use, if that is what is painted. */
  imported: CustomTheme | null;
  /** The name Monaco knows the theme by. */
  monacoTheme: string;
  fonts: FontSettings;
  setTheme: (id: string) => void;
  setMode: (mode: Mode) => void;
  /** The header toggle: the same theme in the other mode. */
  toggleKind: () => void;
  importThemes: (files: { name: string; text: string }[]) => ImportResult;
  removeTheme: (id: string) => void;
  setFont: (area: FontArea, change: Partial<{ family: string; size: number }>) => void;
  resetFonts: () => void;
};

function readJson<T>(key: string): T | null {
  try {
    const text = window.localStorage.getItem(key);
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembering the choice is harmless.
  }
}

function readThemes(): CustomTheme[] {
  const stored = readJson<unknown>(THEMES_KEY);
  if (!Array.isArray(stored)) {
    return [];
  }
  return stored.filter(
    (item): item is CustomTheme =>
      Boolean(item) &&
      typeof (item as CustomTheme).id === "string" &&
      typeof (item as CustomTheme).name === "string" &&
      ((item as CustomTheme).kind === "light" || (item as CustomTheme).kind === "dark") &&
      typeof (item as CustomTheme).vars === "object",
  );
}

function readChoice(): Chosen {
  const stored = readJson<Partial<Chosen>>(SETTINGS_KEY);
  if (stored && typeof stored === "object") {
    let themeId = typeof stored.themeId === "string" ? stored.themeId : DEFAULT_FAMILY;
    let mode: Mode = isMode(stored.mode) ? stored.mode : "system";
    if (!isMode(stored.mode)) {
      // Before each theme had a light and a dark variant, a variant was a theme of its own.
      if (themeId === "ataraxia-light" || themeId === "ataraxia-dark") {
        mode = themeId === "ataraxia-dark" ? "dark" : "light";
        themeId = DEFAULT_FAMILY;
      } else if (themeId === "system") {
        themeId = DEFAULT_FAMILY;
      }
    }
    return {
      themeId,
      mode,
      lastFamily: typeof stored.lastFamily === "string" && isBuiltInFamily(stored.lastFamily) ? stored.lastFamily : isBuiltInFamily(themeId) ? themeId : DEFAULT_FAMILY,
      fonts: normalizeFonts(stored.fonts),
    };
  }
  // Before themes could be chosen, only light or dark was remembered.
  try {
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy === "light" || legacy === "dark") {
      return { ...DEFAULT_CHOICE, mode: legacy };
    }
  } catch {
    // Falls through to the system theme.
  }
  return DEFAULT_CHOICE;
}

function systemKind(): ThemeKind {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

type Active = { kind: ThemeKind; custom: CustomTheme | null; imported: CustomTheme | null; id: string };

function resolve(themeId: string, mode: Mode, themes: CustomTheme[], system: ThemeKind): Active {
  const imported = themes.find((theme) => theme.id === themeId) ?? null;
  if (imported) {
    return { kind: imported.kind, custom: imported, imported, id: imported.id };
  }
  const family = isBuiltInFamily(themeId) ? themeId : DEFAULT_FAMILY;
  const kind = mode === "system" ? system : mode;
  return { kind, custom: builtInTheme(family, kind), imported: null, id: `${family}-${kind}` };
}

const NOT_PROVIDED: Appearance = {
  themeId: DEFAULT_FAMILY,
  mode: "system",
  themes: [],
  kind: "light",
  custom: null,
  imported: null,
  monacoTheme: "ataraxia-light",
  fonts: DEFAULT_FONTS,
  setTheme: () => undefined,
  setMode: () => undefined,
  toggleKind: () => undefined,
  importThemes: () => ({ added: [], errors: [] }),
  removeTheme: () => undefined,
  setFont: () => undefined,
  resetFonts: () => undefined,
};

const AppearanceContext = createContext<Appearance>(NOT_PROVIDED);

export function useAppearance(): Appearance {
  return useContext(AppearanceContext);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<Chosen>(readChoice);
  const [themes, setThemes] = useState<CustomTheme[]>(readThemes);
  const [system, setSystem] = useState<ThemeKind>(systemKind);
  const applied = useRef<string[]>([]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(query.matches ? "dark" : "light");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const active = useMemo(() => resolve(choice.themeId, choice.mode, themes, system), [choice.themeId, choice.mode, themes, system]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(active.kind);
    root.dataset.theme = active.kind;
    for (const key of applied.current) {
      root.style.removeProperty(key);
    }
    const vars = { ...(active.custom?.vars ?? {}), ...fontVars(choice.fonts) };
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }
    applied.current = Object.keys(vars);
    writeJson(APPLIED_KEY, { kind: active.kind, vars });
  }, [active, choice.fonts]);

  useEffect(() => writeJson(SETTINGS_KEY, choice), [choice]);
  useEffect(() => writeJson(THEMES_KEY, themes), [themes]);

  const setTheme = useCallback(
    (id: string) =>
      setChoice((current) => ({ ...current, themeId: id, lastFamily: isBuiltInFamily(id) ? id : current.lastFamily })),
    [],
  );

  const setMode = useCallback((mode: Mode) => setChoice((current) => ({ ...current, mode })), []);

  // The same theme in the other mode; from an imported theme, the built-in one used last.
  const toggleKind = useCallback(() => {
    setChoice((current) => {
      const now = resolve(current.themeId, current.mode, themes, system).kind;
      const family = isBuiltInFamily(current.themeId) ? current.themeId : current.lastFamily;
      return { ...current, themeId: family, mode: now === "dark" ? "light" : "dark" };
    });
  }, [themes, system]);

  const importThemes = useCallback((files: { name: string; text: string }[]): ImportResult => {
    const added: CustomTheme[] = [];
    const errors: string[] = [];
    for (const file of files) {
      if (file.text.length > MAX_FILE_BYTES) {
        errors.push(`${file.name}: the file is larger than 2 MB, which no theme is.`);
        continue;
      }
      try {
        added.push(importVsCodeTheme(file.text, file.name));
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : "could not be read."}`);
      }
    }
    if (added.length > 0) {
      setThemes((current) => {
        const ids = new Set(added.map((theme) => theme.id));
        return [...current.filter((theme) => !ids.has(theme.id)), ...added].slice(-MAX_THEMES);
      });
      // Importing one theme is asking for it: the last one read is switched to.
      const last = added[added.length - 1];
      if (last) {
        setChoice((current) => ({ ...current, themeId: last.id }));
      }
    }
    return { added, errors };
  }, []);

  const removeTheme = useCallback((id: string) => {
    setThemes((current) => current.filter((theme) => theme.id !== id));
    setChoice((current) => ({
      ...current,
      themeId: current.themeId === id ? current.lastFamily : current.themeId,
    }));
  }, []);

  const setFont = useCallback((area: FontArea, change: Partial<{ family: string; size: number }>) => {
    setChoice((current) => ({
      ...current,
      fonts: {
        ...current.fonts,
        [area]: {
          family: change.family !== undefined ? cleanFamily(change.family) : current.fonts[area].family,
          size: change.size !== undefined ? clampSize(area, change.size) : current.fonts[area].size,
        },
      },
    }));
  }, []);

  const resetFonts = useCallback(() => setChoice((current) => ({ ...current, fonts: DEFAULT_FONTS })), []);

  const value = useMemo<Appearance>(
    () => ({
      themeId: choice.themeId,
      mode: choice.mode,
      themes,
      kind: active.kind,
      custom: active.custom,
      imported: active.imported,
      monacoTheme: active.custom ? active.custom.id : active.kind === "dark" ? "ataraxia-dark" : "ataraxia-light",
      fonts: choice.fonts,
      setTheme,
      setMode,
      toggleKind,
      importThemes,
      removeTheme,
      setFont,
      resetFonts,
    }),
    [choice.themeId, choice.mode, choice.fonts, themes, active, setTheme, setMode, toggleKind, importThemes, removeTheme, setFont, resetFonts],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

