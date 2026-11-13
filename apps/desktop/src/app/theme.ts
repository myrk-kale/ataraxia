import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

const THEME_KEY = "ataraxia.theme";

function systemTheme(): ThemeMode {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.dataset.theme = theme;
}

function readTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // Storage can be blocked; the system theme is a fine default.
  }
  return systemTheme();
}

export function useThemeMode() {
  const [theme, setTheme] = useState<ThemeMode>(readTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Not remembering the theme is harmless.
    }
  }, [theme]);

  return {
    theme,
    toggleTheme: () => setTheme((current) => (current === "dark" ? "light" : "dark")),
  };
}
