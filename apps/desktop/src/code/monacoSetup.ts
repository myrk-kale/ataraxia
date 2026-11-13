import type * as MonacoApi from "monaco-editor";

export type Monaco = typeof MonacoApi;

type Defaults = { setDiagnosticsOptions: (options: Record<string, boolean>) => void };
type TypeScriptServices = { typescriptDefaults?: Defaults; javascriptDefaults?: Defaults };

let loading: Promise<Monaco> | null = null;

/**
 * Loads Monaco on first use, entirely from the bundle (no CDN), with its language workers.
 * Code is a space the user may never open, so the editor stays out of the startup path.
 */
export function loadMonaco(): Promise<Monaco> {
  loading ??= (async () => {
    const [monaco, editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker] = await Promise.all([
      import("monaco-editor"),
      import("monaco-editor/editor/editor.worker?worker"),
      import("monaco-editor/language/json/json.worker?worker"),
      import("monaco-editor/language/css/css.worker?worker"),
      import("monaco-editor/language/html/html.worker?worker"),
      import("monaco-editor/language/typescript/ts.worker?worker"),
    ]);
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker(_id: string, label: string) {
        switch (label) {
          case "json":
            return new jsonWorker.default();
          case "css":
          case "scss":
          case "less":
            return new cssWorker.default();
          case "html":
          case "handlebars":
          case "razor":
            return new htmlWorker.default();
          case "typescript":
          case "javascript":
            return new tsWorker.default();
          default:
            return new editorWorker.default();
        }
      },
    };
    // The editor shows files, it does not check them: no squiggles from half-configured projects.
    // The language services have no typings in this Monaco version, hence the narrow local type.
    const services = (monaco as unknown as { typescript?: TypeScriptServices }).typescript;
    const quiet = { noSemanticValidation: true, noSyntaxValidation: true };
    services?.typescriptDefaults?.setDiagnosticsOptions(quiet);
    services?.javascriptDefaults?.setDiagnosticsOptions(quiet);
    defineThemes(monaco);
    return monaco;
  })();
  return loading;
}

/** Registers an imported theme under its id, replacing an earlier version of it. */
export function defineAppTheme(monaco: Monaco, name: string, data: Parameters<Monaco["editor"]["defineTheme"]>[1]) {
  monaco.editor.defineTheme(name, data);
}

/** The find widget, hovers and the fields inside the editor, from the interface tokens of a theme. */
function widget(t: { float: string; ink: string; line: string; tint: string; muted: string; mutedStrong: string; accent: string; accentBg: string; red: string }) {
  return {
    "editorWidget.background": t.float,
    "editorWidget.foreground": t.ink,
    "editorWidget.border": t.line,
    "input.background": t.tint,
    "input.foreground": t.ink,
    "input.border": t.line,
    "input.placeholderForeground": t.muted,
    "inputOption.activeBackground": t.accentBg,
    "inputOption.activeBorder": t.accent,
    "inputOption.activeForeground": t.ink,
    "inputOption.hoverBackground": t.tint,
    "icon.foreground": t.mutedStrong,
    disabledForeground: t.muted,
    errorForeground: t.red,
    "toolbar.hoverBackground": t.tint,
    "editor.findMatchBackground": `${t.accent}59`,
    "editor.findMatchHighlightBackground": `${t.accent}33`,
  };
}

function defineThemes(monaco: Monaco) {
  monaco.editor.defineTheme("ataraxia-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      focusBorder: "#00000000",
      "editor.background": "#ffffff",
      "editor.foreground": "#232522",
      "editorLineNumber.foreground": "#6e716c",
      "editorLineNumber.activeForeground": "#50534e",
      "editor.lineHighlightBackground": "#00000000",
      "editor.selectionBackground": "#66569833",
      "editorCursor.foreground": "#665698",
      "editorIndentGuide.background1": "#eae9e6",
      "editorGutter.background": "#ffffff",
      "scrollbarSlider.background": "#dbdad566",
      ...widget({ float: "#ffffff", ink: "#232522", line: "#dbdad5", tint: "#f4f4f1", muted: "#686b66", mutedStrong: "#50534e", accent: "#665698", accentBg: "#f0edf8", red: "#a4444c" }),
    },
  });
  monaco.editor.defineTheme("ataraxia-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      focusBorder: "#00000000",
      "editor.background": "#161715",
      "editor.foreground": "#e8e9e6",
      "editorLineNumber.foreground": "#8b8e89",
      "editorLineNumber.activeForeground": "#a9aca6",
      "editor.lineHighlightBackground": "#00000000",
      "editor.selectionBackground": "#a99cd844",
      "editorCursor.foreground": "#a99cd8",
      "editorIndentGuide.background1": "#272926",
      "editorGutter.background": "#161715",
      "scrollbarSlider.background": "#36383366",
      ...widget({ float: "#161715", ink: "#e8e9e6", line: "#363833", tint: "#1f211e", muted: "#8b8e89", mutedStrong: "#a9aca6", accent: "#a99cd8", accentBg: "#2a2740", red: "#d98a90" }),
    },
  });
}
