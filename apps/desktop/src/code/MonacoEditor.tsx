import type * as MonacoApi from "monaco-editor";
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { useAppearance } from "../app/appearance/store";
import { familyFor } from "../app/appearance/fonts";
import { placeMenu } from "./menuPlacement";
import { defineAppTheme, loadMonaco, type Monaco } from "./monacoSetup";

/** Pause after the last change of the selection before the menu shows: it waits for the hand to stop. */
const MENU_DELAY_MS = 300;
/** What the menu measures about itself until it has been drawn once. */
const MENU_GUESS = { width: 230, height: 34 };

export type EditorSelection = {
  /** Line of the cursor. */
  line: number;
  startLine: number;
  endLine: number;
  /** Selected text; empty when there is only a cursor. */
  text: string;
};

export type EditorHandle = {
  /** First line in view, to keep your place when the text underneath is swapped. */
  topLine: () => number;
  reveal: (line: number) => void;
  focus: () => void;
  value: () => string;
  selection: () => EditorSelection | null;
};

export type LineMarks = {
  added: number[];
  removed: number[];
  commented: number[];
  /** The function, method or type being reviewed; tinted so it stands out. */
  unitRange?: { start: number; end: number } | null;
};

const NO_MARKS: LineMarks = { added: [], removed: [], commented: [] };

export function MonacoEditor({
  docKey,
  value,
  language,
  readOnly,
  wrap,
  marks = NO_MARKS,
  handleRef,
  onChange,
  onSave,
  onBtw,
  onToggleVersion,
  onToggleWrap,
  onSelection,
  selectionMenu,
}: {
  /** Identifies the document; each key keeps its own buffer and undo history. */
  docKey: string;
  value: string;
  language: string;
  readOnly: boolean;
  /** Long lines wrap at the edge of the editor instead of running on. */
  wrap: boolean;
  marks?: LineMarks;
  handleRef?: Ref<EditorHandle>;
  onChange?: (text: string) => void;
  onSave?: () => void;
  onBtw?: () => void;
  /** Flip between the current and the previous version, from inside the editor. */
  onToggleVersion?: () => void;
  /** Wrap or unwrap long lines (Alt+Z, as in VS Code). */
  onToggleWrap?: () => void;
  onSelection?: (selection: EditorSelection) => void;
  /**
   * A small bar shown next to selected text, once the selection has settled. `dismiss` takes it
   * away (the selection itself stays).
   */
  selectionMenu?: (selection: EditorSelection, dismiss: () => void) => ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | null>(null);
  const decorations = useRef<MonacoApi.editor.IEditorDecorationsCollection | null>(null);
  const callbacks = useRef({ onChange, onSave, onBtw, onToggleVersion, onToggleWrap, onSelection });
  callbacks.current = { onChange, onSave, onBtw, onToggleVersion, onToggleWrap, onSelection };
  const appearance = useAppearance();
  // The editor is created once; what it was created with is read back through a ref.
  const look = useRef(appearance);
  look.current = appearance;
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;
  const [ready, setReady] = useState(false);
  const [menu, setMenu] = useState<{ selection: EditorSelection; top: number; left: number } | null>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  const menuShown = useRef(false);
  menuShown.current = menu !== null;
  const menuEnabled = useRef(Boolean(selectionMenu));
  menuEnabled.current = Boolean(selectionMenu);

  useImperativeHandle(
    handleRef,
    () => ({
      topLine: () => editorRef.current?.getVisibleRanges()[0]?.startLineNumber ?? 1,
      reveal: (line) => editorRef.current?.revealLineNearTop(Math.max(1, line)),
      focus: () => editorRef.current?.focus(),
      value: () => editorRef.current?.getValue() ?? "",
      selection: () => {
        const editor = editorRef.current;
        const range = editor?.getSelection();
        const model = editor?.getModel();
        if (!editor || !range || !model) {
          return null;
        }
        return {
          line: range.positionLineNumber,
          startLine: range.startLineNumber,
          endLine: range.endLineNumber,
          text: range.isEmpty() ? "" : model.getValueInRange(range),
        };
      },
    }),
    [],
  );

  useEffect(() => {
    let disposed = false;
    let cleanup = () => undefined as void;
    void loadMonaco().then((monaco) => {
      if (disposed || !host.current) {
        return;
      }
      monacoRef.current = monaco;
      const editor = monaco.editor.create(host.current, {
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: familyFor("code", look.current.fonts.code),
        fontSize: look.current.fonts.code.size,
        lineHeight: Math.round(look.current.fonts.code.size * 1.6),
        wordWrap: wrapRef.current ? "on" : "off",
        wrappingIndent: "indent",
        scrollBeyondLastLine: false,
        renderLineHighlight: "none",
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        glyphMargin: true,
        lineNumbersMinChars: 3,
        padding: { top: 10, bottom: 24 },
        smoothScrolling: true,
        guides: { indentation: false },
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        accessibilitySupport: "auto",
      });
      editorRef.current = editor;
      decorations.current = editor.createDecorationsCollection([]);
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave?.());
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => callbacks.current.onBtw?.());
      // The same chord as VS Code: Alt+Z wraps the lines or lets them run on.
      editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, () => callbacks.current.onToggleWrap?.());
      // Old and new version: Alt+V, since a bare V would be typed into the code.
      editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyV, () => callbacks.current.onToggleVersion?.());
      const content = editor.onDidChangeModelContent(() => callbacks.current.onChange?.(editor.getValue()));
      const cursor = editor.onDidChangeCursorSelection((event) => {
        const model = editor.getModel();
        if (!model) {
          return;
        }
        const range = event.selection;
        callbacks.current.onSelection?.({
          line: range.positionLineNumber,
          startLine: range.startLineNumber,
          endLine: range.endLineNumber,
          text: range.isEmpty() ? "" : model.getValueInRange(range),
        });
      });
      // The menu: placed from where Monaco says the selection is, and kept there while the editor
      // scrolls. It waits for the pointer to be released and the selection to settle.
      let timer: number | null = null;
      let pointerDown = false;
      const place = () => {
        const range = editor.getSelection();
        const model = editor.getModel();
        const node = host.current;
        if (!menuEnabled.current || !range || range.isEmpty() || !model || !node) {
          setMenu(null);
          return;
        }
        const spot = (position: MonacoApi.IPosition) => {
          const found = editor.getScrolledVisiblePosition(position);
          return found ? { top: found.top, left: found.left, height: found.height } : null;
        };
        const box = menuBox.current?.getBoundingClientRect();
        const placed = placeMenu(
          spot(range.getStartPosition()),
          spot(range.getEndPosition()),
          { width: node.clientWidth, height: node.clientHeight },
          box && box.width > 0 ? { width: box.width, height: box.height } : MENU_GUESS,
        );
        if (!placed) {
          setMenu(null);
          return;
        }
        setMenu({
          selection: {
            line: range.positionLineNumber,
            startLine: range.startLineNumber,
            endLine: range.endLineNumber,
            text: model.getValueInRange(range),
          },
          ...placed,
        });
      };
      const settle = () => {
        if (timer !== null) {
          window.clearTimeout(timer);
        }
        timer = window.setTimeout(() => {
          timer = null;
          if (!pointerDown) {
            place();
          }
        }, MENU_DELAY_MS);
      };
      const selecting = editor.onDidChangeCursorSelection((event) => {
        if (event.selection.isEmpty()) {
          if (timer !== null) {
            window.clearTimeout(timer);
          }
          setMenu(null);
        } else {
          settle();
        }
      });
      const pressed = editor.onMouseDown(() => {
        pointerDown = true;
        setMenu(null);
      });
      const released = editor.onMouseUp(() => {
        pointerDown = false;
        settle();
      });
      const scrolled = editor.onDidScrollChange(() => {
        if (menuShown.current) {
          place();
        }
      });
      const switched = editor.onDidChangeModel(() => setMenu(null));
      const typed = editor.onDidChangeModelContent(() => setMenu(null));
      const keys = editor.onKeyDown((event) => {
        if (event.keyCode === monaco.KeyCode.Escape) {
          setMenu(null);
        }
      });
      cleanup = () => {
        if (timer !== null) {
          window.clearTimeout(timer);
        }
        selecting.dispose();
        pressed.dispose();
        released.dispose();
        scrolled.dispose();
        switched.dispose();
        typed.dispose();
        keys.dispose();
        content.dispose();
        cursor.dispose();
        editor.getModel()?.dispose();
        editor.dispose();
        editorRef.current = null;
      };
      setReady(true);
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  // One model per document: switching files keeps cursor, scroll state and undo history.
  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!ready || !monaco || !editor) {
      return;
    }
    const uri = monaco.Uri.parse(`ataraxia://doc/${encodeURIComponent(docKey)}`);
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(value, language, uri);
    } else if (model.getValue() !== value) {
      model.setValue(value);
    }
    if (model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language);
    }
    if (editor.getModel() !== model) {
      const previous = editor.getModel();
      editor.setModel(model);
      // Models of documents no longer shown are not kept around forever.
      if (previous && previous !== model) {
        previous.dispose();
      }
    }
  }, [ready, docKey, value, language]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly, domReadOnly: readOnly });
  }, [ready, readOnly]);

  // The theme in use: the built-in ones are defined with the editor, an imported one is defined here.
  const customTheme = appearance.custom;
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!ready || !monaco) {
      return;
    }
    if (customTheme) {
      defineAppTheme(monaco, customTheme.id, customTheme.monaco);
    }
    monaco.editor.setTheme(appearance.monacoTheme);
  }, [ready, customTheme, appearance.monacoTheme]);

  const codeFont = appearance.fonts.code;
  useEffect(() => {
    editorRef.current?.updateOptions({
      fontFamily: familyFor("code", codeFont),
      fontSize: codeFont.size,
      lineHeight: Math.round(codeFont.size * 1.6),
    });
  }, [ready, codeFont]);

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wrap ? "on" : "off" });
  }, [ready, wrap]);

  useEffect(() => {
    const collection = decorations.current;
    if (!ready || !collection) {
      return;
    }
    const whole = (line: number, className: string, gutter: string) => ({
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      options: { isWholeLine: true, className, linesDecorationsClassName: gutter },
    });
    const unit = marks.unitRange
      ? [
          {
            range: {
              startLineNumber: marks.unitRange.start,
              startColumn: 1,
              endLineNumber: marks.unitRange.end,
              endColumn: 1,
            },
            options: { isWholeLine: true, className: "cg-unit-range" },
          },
        ]
      : [];
    collection.set([
      ...unit,
      ...marks.added.map((line) => whole(line, "cg-line-added", "cg-gutter-added")),
      ...marks.removed.map((line) => whole(line, "cg-line-removed", "cg-gutter-removed")),
      ...marks.commented.map((line) => ({
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: { glyphMarginClassName: "cg-glyph-comment" },
      })),
    ]);
  }, [ready, marks, docKey, value]);

  return (
    <div className="relative h-full min-h-0 w-full">
      <div
        ref={host}
        className="h-full min-h-0 w-full"
        data-editor-readonly={readOnly ? "true" : "false"}
        role="region"
        aria-label="Code editor"
      />
      {menu && selectionMenu ? (
        <div
          ref={menuBox}
          className="absolute z-10"
          style={{ top: menu.top, left: menu.left }}
          // Choosing from the bar must not take focus, and with it the selection, from the editor.
          onMouseDown={(event) => event.preventDefault()}
        >
          {selectionMenu(menu.selection, () => setMenu(null))}
        </div>
      ) : null}
    </div>
  );
}
