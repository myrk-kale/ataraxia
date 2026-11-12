import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

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

export function useThemeMode() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const stored = window.localStorage.getItem("concierge.theme");
    if (stored === "light" || stored === "dark") {
      return stored;
    }
    return systemTheme();
  });

  useEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem("concierge.theme", theme);
  }, [theme]);

  return {
    theme,
    toggleTheme: () => setTheme((current) => (current === "dark" ? "light" : "dark")),
  };
}
