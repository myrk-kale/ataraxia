/**
 * The themes that ship with the app. Ataraxia is drawn by the stylesheet; every other one is a
 * small palette that is turned into a VS Code theme and read by the same importer an imported
 * theme goes through, so each variant gets the same contrast guarantees.
 */
import { importVsCodeTheme, type CustomTheme, type ThemeKind } from "./vscode";

export const DEFAULT_FAMILY = "ataraxia";

type Palette = {
  bg: string;
  side: string;
  fg: string;
  accent: string;
  comment: string;
  string: string;
  keyword: string;
  number: string;
  fn: string;
  type: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  /** The main button, when the theme does not simply use its text colour for it. */
  primary?: string;
  onPrimary?: string;
};

type Family = { id: string; name: string; light?: Palette; dark?: Palette };

const FAMILIES: Family[] = [
  { id: DEFAULT_FAMILY, name: "Ataraxia" },
  // The default theme of Orca (github.com/stablyai/orca, MIT): its neutral surfaces and blue accent,
  // the terminal colours it uses (Ghostty's default style, dark; Tango, light) and the editor colours
  // of VS Code's own Dark+ and Light+.
  {
    id: "orca",
    name: "Orca",
    dark: { bg: "#0a0a0a", side: "#171717", fg: "#f0f0f0", accent: "#51a2ff", comment: "#6a9955", string: "#ce9178", keyword: "#569cd6", number: "#b5cea8", fn: "#dcdcaa", type: "#4ec9b0", red: "#cc6666", green: "#b5bd68", yellow: "#f0c674", blue: "#81a2be", magenta: "#b294bb", cyan: "#8abeb7", primary: "#e5e5e5", onPrimary: "#171717" },
    light: { bg: "#ffffff", side: "#fafafa", fg: "#0a0a0a", accent: "#155dfc", comment: "#008000", string: "#a31515", keyword: "#0000ff", number: "#098658", fn: "#795e26", type: "#267f99", red: "#cc0000", green: "#4e9a06", yellow: "#8e7700", blue: "#3465a4", magenta: "#75507b", cyan: "#05727e", primary: "#171717", onPrimary: "#fafafa" },
  },
  {
    id: "nord",
    name: "Nord",
    dark: { bg: "#2e3440", side: "#292e39", fg: "#d8dee9", accent: "#88c0d0", comment: "#616e88", string: "#a3be8c", keyword: "#81a1c1", number: "#b48ead", fn: "#88c0d0", type: "#8fbcbb", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b", blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0" },
    light: { bg: "#eceff4", side: "#e5e9f0", fg: "#2e3440", accent: "#5e81ac", comment: "#7b88a1", string: "#5a7d47", keyword: "#5e81ac", number: "#8a5b99", fn: "#3d7a8a", type: "#3b7e7a", red: "#bf616a", green: "#4f7a42", yellow: "#a8741a", blue: "#5e81ac", magenta: "#8a5b99", cyan: "#3d7a8a" },
  },
  {
    id: "solarized",
    name: "Solarized",
    dark: { bg: "#002b36", side: "#00252f", fg: "#93a1a1", accent: "#268bd2", comment: "#586e75", string: "#2aa198", keyword: "#859900", number: "#d33682", fn: "#268bd2", type: "#b58900", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198" },
    light: { bg: "#fdf6e3", side: "#eee8d5", fg: "#586e75", accent: "#268bd2", comment: "#93a1a1", string: "#2aa198", keyword: "#859900", number: "#d33682", fn: "#268bd2", type: "#b58900", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198" },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    dark: { bg: "#282828", side: "#1d2021", fg: "#ebdbb2", accent: "#83a598", comment: "#928374", string: "#b8bb26", keyword: "#fb4934", number: "#d3869b", fn: "#fabd2f", type: "#8ec07c", red: "#fb4934", green: "#b8bb26", yellow: "#fabd2f", blue: "#83a598", magenta: "#d3869b", cyan: "#8ec07c" },
    light: { bg: "#fbf1c7", side: "#ebdbb2", fg: "#3c3836", accent: "#076678", comment: "#928374", string: "#79740e", keyword: "#9d0006", number: "#8f3f71", fn: "#b57614", type: "#427b58", red: "#9d0006", green: "#79740e", yellow: "#b57614", blue: "#076678", magenta: "#8f3f71", cyan: "#427b58" },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    dark: { bg: "#1a1b26", side: "#16161e", fg: "#c0caf5", accent: "#7aa2f7", comment: "#565f89", string: "#9ece6a", keyword: "#bb9af7", number: "#ff9e64", fn: "#7aa2f7", type: "#2ac3de", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68", blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff" },
    light: { bg: "#e1e2e7", side: "#d5d6db", fg: "#3760bf", accent: "#2e7de9", comment: "#848cb5", string: "#587539", keyword: "#9854f1", number: "#b15c00", fn: "#2e7de9", type: "#007197", red: "#f52a65", green: "#587539", yellow: "#8c6c3e", blue: "#2e7de9", magenta: "#9854f1", cyan: "#007197" },
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    dark: { bg: "#1e1e2e", side: "#181825", fg: "#cdd6f4", accent: "#89b4fa", comment: "#6c7086", string: "#a6e3a1", keyword: "#cba6f7", number: "#fab387", fn: "#89b4fa", type: "#f9e2af", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af", blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5" },
    light: { bg: "#eff1f5", side: "#e6e9ef", fg: "#4c4f69", accent: "#1e66f5", comment: "#9ca0b0", string: "#40a02b", keyword: "#8839ef", number: "#fe640b", fn: "#1e66f5", type: "#df8e1d", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d", blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299" },
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    dark: { bg: "#191724", side: "#16141f", fg: "#e0def4", accent: "#c4a7e7", comment: "#6e6a86", string: "#f6c177", keyword: "#9ccfd8", number: "#ebbcba", fn: "#c4a7e7", type: "#9ccfd8", red: "#eb6f92", green: "#9ccfd8", yellow: "#f6c177", blue: "#9ccfd8", magenta: "#c4a7e7", cyan: "#9ccfd8" },
    light: { bg: "#faf4ed", side: "#f2e9e1", fg: "#575279", accent: "#907aa9", comment: "#9893a5", string: "#c07c1c", keyword: "#286983", number: "#b4637a", fn: "#7d5fa3", type: "#56949f", red: "#b4637a", green: "#3f8a8f", yellow: "#b9770e", blue: "#286983", magenta: "#907aa9", cyan: "#56949f" },
  },
  {
    id: "one",
    name: "One",
    dark: { bg: "#282c34", side: "#21252b", fg: "#abb2bf", accent: "#61afef", comment: "#5c6370", string: "#98c379", keyword: "#c678dd", number: "#d19a66", fn: "#61afef", type: "#e5c07b", red: "#e06c75", green: "#98c379", yellow: "#e5c07b", blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2" },
    light: { bg: "#fafafa", side: "#f0f0f0", fg: "#383a42", accent: "#4078f2", comment: "#a0a1a7", string: "#50a14f", keyword: "#a626a4", number: "#986801", fn: "#4078f2", type: "#c18401", red: "#e45649", green: "#50a14f", yellow: "#c18401", blue: "#4078f2", magenta: "#a626a4", cyan: "#0184bc" },
  },
  {
    id: "everforest",
    name: "Everforest",
    dark: { bg: "#2d353b", side: "#272e33", fg: "#d3c6aa", accent: "#a7c080", comment: "#859289", string: "#a7c080", keyword: "#e67e80", number: "#d699b6", fn: "#a7c080", type: "#dbbc7f", red: "#e67e80", green: "#a7c080", yellow: "#dbbc7f", blue: "#7fbbb3", magenta: "#d699b6", cyan: "#83c092" },
    light: { bg: "#fffbef", side: "#f8f5e4", fg: "#5c6a72", accent: "#8da101", comment: "#939f91", string: "#8da101", keyword: "#f85552", number: "#df69ba", fn: "#8da101", type: "#dfa000", red: "#f85552", green: "#8da101", yellow: "#dfa000", blue: "#3a94c5", magenta: "#df69ba", cyan: "#35a77c" },
  },
  {
    id: "github",
    name: "GitHub",
    dark: { bg: "#0d1117", side: "#010409", fg: "#e6edf3", accent: "#4493f8", comment: "#8b949e", string: "#a5d6ff", keyword: "#ff7b72", number: "#79c0ff", fn: "#d2a8ff", type: "#ffa657", red: "#ff7b72", green: "#3fb950", yellow: "#d29922", blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf" },
    light: { bg: "#ffffff", side: "#f6f8fa", fg: "#1f2328", accent: "#0969da", comment: "#59636e", string: "#0a3069", keyword: "#cf222e", number: "#0550ae", fn: "#8250df", type: "#953800", red: "#cf222e", green: "#1a7f37", yellow: "#9a6700", blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83" },
  },
];

/** What the settings list: each theme once, with its light and dark variants behind it. */
export const BUILT_IN_THEMES: readonly { id: string; name: string }[] = FAMILIES.map(({ id, name }) => ({ id, name }));

export function isBuiltInFamily(id: string): boolean {
  return FAMILIES.some((family) => family.id === id);
}

function themeFile(family: Family, kind: ThemeKind, palette: Palette): string {
  const ansi = (name: string, value: string) => ({ [`terminal.ansi${name}`]: value, [`terminal.ansiBright${name}`]: value });
  return JSON.stringify({
    name: `${family.name} ${kind === "dark" ? "Dark" : "Light"}`,
    type: kind,
    colors: {
      "editor.background": palette.bg,
      "editor.foreground": palette.fg,
      "sideBar.background": palette.side,
      "textLink.foreground": palette.accent,
      ...(palette.primary ? { "button.background": palette.primary, "button.foreground": palette.onPrimary ?? palette.bg } : {}),
      ...ansi("Black", palette.side),
      ...ansi("Red", palette.red),
      ...ansi("Green", palette.green),
      ...ansi("Yellow", palette.yellow),
      ...ansi("Blue", palette.blue),
      ...ansi("Magenta", palette.magenta),
      ...ansi("Cyan", palette.cyan),
      ...ansi("White", palette.fg),
    },
    tokenColors: [
      { settings: { foreground: palette.fg } },
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: palette.comment, fontStyle: "italic" } },
      { scope: ["string", "string.quoted"], settings: { foreground: palette.string } },
      { scope: ["keyword", "storage", "storage.type"], settings: { foreground: palette.keyword } },
      { scope: ["constant.numeric", "constant.language"], settings: { foreground: palette.number } },
      { scope: ["entity.name.function", "support.function"], settings: { foreground: palette.fn } },
      { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class"], settings: { foreground: palette.type } },
      { scope: ["variable.parameter"], settings: { foreground: palette.yellow } },
      { scope: ["entity.name.tag"], settings: { foreground: palette.red } },
    ],
  });
}

const cache = new Map<string, CustomTheme>();

/**
 * One variant of a built-in theme, ready to apply. Ataraxia is the stylesheet's own, so it has no
 * theme object: `null` means "leave the defaults".
 */
export function builtInTheme(familyId: string, kind: ThemeKind): CustomTheme | null {
  const family = FAMILIES.find((item) => item.id === familyId);
  const palette = family?.[kind];
  if (!family || !palette) {
    return null;
  }
  const key = `${family.id}-${kind}`;
  let theme = cache.get(key);
  if (!theme) {
    theme = { ...importVsCodeTheme(themeFile(family, kind, palette)), id: key };
    cache.set(key, theme);
  }
  return theme;
}
