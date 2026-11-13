import type * as MonacoApi from "monaco-editor";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { loadMonaco, type Monaco } from "./monacoSetup";

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
  dark,
  marks = NO_MARKS,
  handleRef,
  onChange,
  onSave,
  onBtw,
  onToggleVersion,
  onSelection,
}: {
  /** Identifies the document; each key keeps its own buffer and undo history. */
  docKey: string;
  value: string;
  language: string;
  readOnly: boolean;
  dark: boolean;
  marks?: LineMarks;
  handleRef?: Ref<EditorHandle>;
  onChange?: (text: string) => void;
  onSave?: () => void;
  onBtw?: () => void;
  /** Flip between the current and the previous version, from inside the editor. */
  onToggleVersion?: () => void;
  onSelection?: (selection: EditorSelection) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | null>(null);
  const decorations = useRef<MonacoApi.editor.IEditorDecorationsCollection | null>(null);
  const callbacks = useRef({ onChange, onSave, onBtw, onToggleVersion, onSelection });
  callbacks.current = { onChange, onSave, onBtw, onToggleVersion, onSelection };
  const [ready, setReady] = useState(false);

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
        fontFamily: '"Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace',
        fontSize: 12.5,
        lineHeight: 20,
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
      // A bare V would be typed into the code now that the current version can be edited.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyV, () => callbacks.current.onToggleVersion?.());
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
      cleanup = () => {
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

  useEffect(() => {
    monacoRef.current?.editor.setTheme(dark ? "ataraxia-dark" : "ataraxia-light");
  }, [ready, dark]);

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
    <div
      ref={host}
      className="h-full min-h-0 w-full"
      data-editor-readonly={readOnly ? "true" : "false"}
      role="region"
      aria-label="Code editor"
    />
  );
}
