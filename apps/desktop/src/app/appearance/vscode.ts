/**
 * VS Code colour themes, read as they are published: the `.json` file of a theme (comments and
 * trailing commas allowed, as VS Code does), with its `colors` for the workbench and its
 * `tokenColors` for code. They are turned into what Ataraxia paints with: the interface tokens, the
 * Monaco theme and the terminal palette. Every text colour is held to a contrast floor, so a
 * theme made for an editor still reads in the panels around it.
 */
import { BLACK, WHITE, contrast, ensureContrast, mix, over, parseColor, readableOn, toHex, type Rgb } from "./color";

export type ThemeKind = "light" | "dark";

export type MonacoRule = { token: string; foreground?: string; fontStyle?: string };

export type MonacoThemeData = {
  base: "vs" | "vs-dark" | "hc-black" | "hc-light";
  inherit: boolean;
  rules: MonacoRule[];
  colors: Record<string, string>;
};

/** A theme the person imported, ready to apply: nothing is computed again when it loads. */
export type CustomTheme = {
  id: string;
  name: string;
  kind: ThemeKind;
  /** Interface tokens (`--cg-*`) this theme sets; the ones it leaves out come from its kind. */
  vars: Record<string, string>;
  monaco: MonacoThemeData;
  /** xterm colours: background, foreground, cursor, selection and the ANSI palette it defines. */
  terminal: Record<string, string>;
  /** Things in the file that this version does not apply. */
  warnings: string[];
};

type TokenColor = { scope?: string | string[]; settings?: { foreground?: string; fontStyle?: string } };

type ThemeFile = {
  name?: unknown;
  type?: unknown;
  colors?: unknown;
  tokenColors?: unknown;
  include?: unknown;
  semanticTokenColors?: unknown;
  contributes?: { themes?: { label?: string; path?: string }[] };
};

/** JSON with comments and trailing commas, which is what theme files are in practice. */
export function parseJsonc(text: string): unknown {
  const source = text.replace(/^﻿/, "");
  let stripped = "";
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at] as string;
    if (char === '"') {
      let end = at + 1;
      while (end < source.length && source[end] !== '"') {
        end += source[end] === "\\" ? 2 : 1;
      }
      stripped += source.slice(at, end + 1);
      at = end;
    } else if (char === "/" && source[at + 1] === "/") {
      while (at < source.length && source[at] !== "\n") {
        at += 1;
      }
      stripped += "\n";
    } else if (char === "/" && source[at + 1] === "*") {
      const close = source.indexOf("*/", at + 2);
      at = close === -1 ? source.length : close + 1;
      stripped += " ";
    } else {
      stripped += char;
    }
  }
  let clean = "";
  for (let at = 0; at < stripped.length; at += 1) {
    const char = stripped[at] as string;
    if (char === '"') {
      let end = at + 1;
      while (end < stripped.length && stripped[end] !== '"') {
        end += stripped[end] === "\\" ? 2 : 1;
      }
      clean += stripped.slice(at, end + 1);
      at = end;
    } else if (char === ",") {
      const next = stripped.slice(at + 1).match(/\S/)?.[0];
      if (next !== "}" && next !== "]") {
        clean += char;
      }
    } else {
      clean += char;
    }
  }
  return JSON.parse(clean);
}

/** Which Monaco token each TextMate scope colours. Monaco tokenizes with its own grammars, so this is an approximation. */
const SCOPE_TOKENS: readonly [string, readonly string[]][] = [
  ["comment", ["comment"]],
  ["string.regexp", ["regexp"]],
  ["constant.regexp", ["regexp"]],
  ["constant.character.escape", ["string.escape"]],
  ["string", ["string"]],
  ["constant.numeric", ["number"]],
  ["keyword.operator", ["operator"]],
  ["keyword", ["keyword"]],
  ["storage", ["keyword"]],
  ["entity.name.type", ["type", "type.identifier"]],
  ["entity.name.class", ["type", "type.identifier"]],
  ["entity.other.inherited-class", ["type", "type.identifier"]],
  ["support.type", ["type", "type.identifier"]],
  ["support.class", ["type", "type.identifier"]],
  ["entity.name.tag", ["tag"]],
  ["entity.other.attribute-name", ["attribute.name"]],
  ["meta.decorator", ["annotation"]],
  ["entity.name.function.decorator", ["annotation"]],
  ["punctuation.definition.tag", ["delimiter.html", "delimiter.xml"]],
  ["punctuation", ["delimiter"]],
  ["variable", ["variable", "identifier"]],
];

function tokensOf(scope: string): readonly string[] {
  // A selector can be a path ("source.ts meta.x string"): the last part is what is being coloured.
  const last = scope.trim().split(/\s+/).pop() ?? "";
  if (!last || last.startsWith("-") || last.includes(":")) {
    return [];
  }
  for (const [prefix, tokens] of SCOPE_TOKENS) {
    if (last === prefix || last.startsWith(`${prefix}.`)) {
      return tokens;
    }
  }
  return [];
}

function monacoRules(tokenColors: TokenColor[], panel: Rgb): MonacoRule[] {
  const rules: MonacoRule[] = [];
  for (const rule of tokenColors) {
    if (!rule || typeof rule !== "object" || !rule.scope) {
      continue;
    }
    const foreground = parseColor(rule.settings?.foreground);
    const fontStyle = typeof rule.settings?.fontStyle === "string" ? rule.settings.fontStyle : undefined;
    if (!foreground && fontStyle === undefined) {
      continue;
    }
    const scopes = (Array.isArray(rule.scope) ? rule.scope : String(rule.scope).split(",")).map(String);
    for (const scope of scopes) {
      for (const token of tokensOf(scope)) {
        rules.push({
          token,
          ...(foreground ? { foreground: toHex(over(foreground, panel)).slice(1) } : {}),
          ...(fontStyle !== undefined ? { fontStyle } : {}),
        });
      }
    }
  }
  return rules;
}

const ANSI_NAMES = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"] as const;

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "theme";
}

/** The kind a file declares, or, when it declares none, the one its editor background has. */
function kindOf(type: unknown, panel: Rgb): { kind: ThemeKind; base: MonacoThemeData["base"] } {
  switch (type) {
    case "hc":
    case "hc-black":
      return { kind: "dark", base: "hc-black" };
    case "hcLight":
    case "hc-light":
      return { kind: "light", base: "hc-light" };
    case "dark":
      return { kind: "dark", base: "vs-dark" };
    case "light":
      return { kind: "light", base: "vs" };
    default: {
      const dark = contrast(panel, BLACK) < contrast(panel, WHITE);
      return { kind: dark ? "dark" : "light", base: dark ? "vs-dark" : "vs" };
    }
  }
}

/**
 * Reads the text of a VS Code theme file. It throws an `Error` whose message is meant to be shown
 * as it is: what the file is, and what to do instead.
 */
export function importVsCodeTheme(text: string, fileName = ""): CustomTheme {
  let file: ThemeFile;
  try {
    const parsed = parseJsonc(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    file = parsed as ThemeFile;
  } catch {
    throw new Error("This is not a VS Code theme: the file is not valid JSON.");
  }
  const listed = file.contributes?.themes;
  if (Array.isArray(listed) && listed.length > 0) {
    const paths = listed.map((theme) => theme.path ?? theme.label).filter(Boolean).join(", ");
    throw new Error(`This is an extension manifest, not a theme. Import the theme files it lists: ${paths}.`);
  }
  const rawColors = file.colors && typeof file.colors === "object" ? (file.colors as Record<string, unknown>) : {};
  const tokenColors = Array.isArray(file.tokenColors) ? (file.tokenColors as TokenColor[]) : [];
  if (Object.keys(rawColors).length === 0 && tokenColors.length === 0) {
    throw new Error("This file has no `colors` and no `tokenColors`, so there is nothing of a theme in it.");
  }

  const warnings: string[] = [];
  if (typeof file.include === "string") {
    warnings.push(`It builds on ${file.include}, which cannot be loaded from a single file, so what that file defines is missing.`);
  }
  if (typeof file.tokenColors === "string") {
    warnings.push(`Its code colours are in ${file.tokenColors}, which cannot be loaded from a single file.`);
  }
  if (file.semanticTokenColors && Object.keys(file.semanticTokenColors as object).length > 0) {
    warnings.push("Its semantic token colours are not applied.");
  }

  const name = (typeof file.name === "string" && file.name.trim()) || fileName.replace(/\.(jsonc?)$/i, "") || "Imported theme";
  const fallback = (kind: ThemeKind) => (kind === "dark" ? { r: 30, g: 30, b: 30 } : { r: 255, g: 255, b: 255 });
  const declared = parseColor(rawColors["editor.background"]);
  const guess = declared ? { r: declared.r, g: declared.g, b: declared.b } : null;
  const { kind, base } = kindOf(file.type, guess ?? fallback("dark"));
  const panel: Rgb = guess ?? fallback(kind);

  const color = (...keys: string[]): Rgb | null => {
    for (const key of keys) {
      const parsed = parseColor(rawColors[key]);
      if (parsed) {
        return over(parsed, panel);
      }
    }
    return null;
  };
  const global = tokenColors.find((rule) => rule && !rule.scope)?.settings?.foreground;
  const ink = ensureContrast(color("editor.foreground", "foreground") ?? over(parseColor(global) ?? { ...fallbackInk(kind), a: 1 }, panel), panel, 7);
  const dark = kind === "dark";
  const side = color("sideBar.background") ?? mix(panel, ink, dark ? 0.045 : 0.03);
  const tint = mix(panel, ink, dark ? 0.06 : 0.045);
  const bubble = mix(panel, ink, dark ? 0.08 : 0.05);
  const line = mix(panel, ink, 0.11);
  const lineStrong = mix(panel, ink, 0.2);
  const control = ensureContrast(mix(panel, ink, 0.45), panel, 3);
  const muted = ensureContrast(mix(panel, ink, 0.58), [panel, tint, side], 4.6);
  const mutedStrong = ensureContrast(mix(panel, ink, 0.75), [panel, tint, side], 7);
  const accentSource = color("textLink.foreground", "button.background", "focusBorder") ?? (dark ? { r: 169, g: 156, b: 216 } : { r: 102, g: 86, b: 152 });
  const accent = ensureContrast(accentSource, [panel, tint], 4.6);
  const accentBg = mix(panel, accent, 0.16);
  const primary = color("button.background") ?? ink;
  const onPrimary = ensureContrast(color("button.foreground") ?? readableOn(primary), primary, 4.5);
  const primaryHover = color("button.hoverBackground") ?? mix(primary, dark ? WHITE : BLACK, 0.14);
  const status = (fallbackColor: Rgb, ...keys: string[]) => ensureContrast(color(...keys) ?? fallbackColor, [panel, tint], 4.6);
  const green = status(dark ? { r: 110, g: 174, b: 142 } : { r: 44, g: 107, b: 85 }, "gitDecoration.addedResourceForeground", "terminal.ansiGreen", "editorGutter.addedBackground");
  const red = status(dark ? { r: 217, g: 138, b: 144 } : { r: 164, g: 68, b: 76 }, "errorForeground", "gitDecoration.deletedResourceForeground", "terminal.ansiRed");
  const amber = status(dark ? { r: 228, g: 173, b: 103 } : { r: 138, g: 90, b: 18 }, "editorWarning.foreground", "gitDecoration.modifiedResourceForeground", "terminal.ansiYellow");
  const addBg = color("diffEditor.insertedLineBackground", "diffEditor.insertedTextBackground") ?? mix(panel, green, 0.14);
  const delBg = color("diffEditor.removedLineBackground", "diffEditor.removedTextBackground") ?? mix(panel, red, 0.14);
  const addFg = ensureContrast(green, addBg, 4.5);
  const delFg = ensureContrast(red, delBg, 4.5);

  const vars: Record<string, string> = {
    "--cg-canvas": toHex(side),
    "--cg-panel": toHex(panel),
    "--cg-sidebar": toHex(side),
    "--cg-line": toHex(line),
    "--cg-line-strong": toHex(lineStrong),
    "--cg-control": toHex(control),
    "--cg-ink": toHex(ink),
    "--cg-muted": toHex(muted),
    "--cg-muted-strong": toHex(mutedStrong),
    "--cg-tint": toHex(tint),
    "--cg-bubble": toHex(bubble),
    "--cg-accent": toHex(accent),
    "--cg-accent-bg": toHex(accentBg),
    "--cg-green": toHex(green),
    "--cg-red": toHex(red),
    "--cg-amber": toHex(amber),
    "--cg-amber-text": toHex(amber),
    "--cg-primary": toHex(primary),
    "--cg-primary-hover": toHex(primaryHover),
    "--cg-on-primary": toHex(onPrimary),
    "--cg-tip-bg": toHex(ink),
    "--cg-tip-fg": toHex(panel),
    "--cg-add-bg": toHex(addBg),
    "--cg-add-fg": toHex(addFg),
    "--cg-del-bg": toHex(delBg),
    "--cg-del-fg": toHex(delFg),
    "--cg-float": toHex(color("editorWidget.background") ?? panel),
  };

  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawColors)) {
    if (parseColor(value)) {
      colors[key] = String(value).trim();
    }
  }
  colors["editor.background"] = toHex(panel);
  colors["editor.foreground"] = toHex(ink);
  colors["editorGutter.background"] = toHex(panel);
  colors["focusBorder"] = "#00000000";
  colors["editorLineNumber.foreground"] = toHex(muted);
  colors["editorLineNumber.activeForeground"] = toHex(mutedStrong);
  colors["scrollbarSlider.background"] = `${toHex(lineStrong)}66`;
  // The find widget, the hover cards and every field inside the editor, painted from the same tokens.
  Object.assign(colors, {
    "editorWidget.background": vars["--cg-float"],
    "editorWidget.foreground": toHex(ink),
    "editorWidget.border": toHex(lineStrong),
    "input.background": toHex(tint),
    "input.foreground": toHex(ink),
    "input.border": toHex(lineStrong),
    "input.placeholderForeground": toHex(muted),
    "inputOption.activeBackground": toHex(accentBg),
    "inputOption.activeBorder": toHex(accent),
    "inputOption.activeForeground": toHex(ink),
    "inputOption.hoverBackground": toHex(tint),
    "icon.foreground": toHex(mutedStrong),
    disabledForeground: toHex(muted),
    errorForeground: toHex(red),
    "toolbar.hoverBackground": toHex(tint),
    "editor.findMatchBackground": `${toHex(accent)}59`,
    "editor.findMatchHighlightBackground": `${toHex(accent)}33`,
  });
  const rules = monacoRules(tokenColors, panel);
  rules.unshift({ token: "", foreground: toHex(ink).slice(1) });

  const terminal: Record<string, string> = {
    background: toHex(side),
    foreground: toHex(ensureContrast(ink, side, 7)),
    cursor: toHex(accent),
    selectionBackground: `${toHex(accent)}47`,
  };
  ANSI_NAMES.forEach((ansi) => {
    const normal = color(`terminal.ansi${ansi}`);
    const bright = color(`terminal.ansiBright${ansi}`);
    // The darkest and lightest ANSI colours would vanish into the terminal's own background.
    const keep = (value: Rgb | null) => (value ? toHex(ensureContrast(value, side, ansi === "Black" ? 1.6 : 4.5)) : null);
    const lower = ansi.toLowerCase();
    const n = keep(normal);
    const b = keep(bright);
    if (n) terminal[lower] = n;
    if (b) terminal[`bright${ansi}`] = b;
  });

  return {
    // Also the name Monaco registers it under, which only allows lowercase letters, digits and dashes.
    id: `vscode-${slug(name)}`,
    name,
    kind,
    vars,
    monaco: { base, inherit: true, rules, colors },
    terminal,
    warnings,
  };
}

function fallbackInk(kind: ThemeKind): Rgb {
  return kind === "dark" ? { r: 212, g: 212, b: 212 } : { r: 51, g: 51, b: 51 };
}
