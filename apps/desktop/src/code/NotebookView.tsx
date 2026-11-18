import { useEffect, useMemo, useState } from "react";
import { useAppearance } from "../app/appearance/store";
import { Markdown } from "../chat/Markdown";
import { loadMonaco } from "./monacoSetup";
import { parseNotebook, type NotebookCell, type NotebookOutput } from "./notebook";

/** Colours code with the editor's own tokenizer and theme; plain text until it is ready. */
function useColorized(source: string, language: string): string | null {
  const appearance = useAppearance();
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadMonaco()
      .then(async (monaco) => {
        monaco.editor.setTheme(appearance.monacoTheme);
        const colored = await monaco.editor.colorize(source, language, { tabSize: 4 });
        if (live) {
          setHtml(colored);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [source, language, appearance.monacoTheme]);
  return html;
}

function Code({ source, language }: { source: string; language: string }) {
  const colored = useColorized(source, language);
  const shared = "overflow-x-auto rounded-cg-md bg-cg-tint px-4 py-3 font-mono text-small leading-[1.7] whitespace-pre";
  // Monaco escapes the text it colours; what it returns is spans and line breaks.
  return colored ? (
    <div className={shared} dangerouslySetInnerHTML={{ __html: colored }} />
  ) : (
    <pre className={shared}>{source}</pre>
  );
}

function Output({ output }: { output: NotebookOutput }) {
  switch (output.kind) {
    case "text":
      return (
        <pre
          className={`overflow-x-auto font-mono text-small leading-[1.6] whitespace-pre-wrap ${
            output.stream === "stderr" ? "rounded-cg-sm bg-cg-del-bg px-2 py-1 text-cg-del-fg" : "text-cg-ink"
          }`}
        >
          {output.text}
        </pre>
      );
    case "image":
      return <img alt="Output of the cell" className="max-w-full rounded-cg-sm bg-white" src={output.src} />;
    case "markdown":
      return (
        <div className="text-ui leading-6">
          <Markdown text={output.text} />
        </div>
      );
    case "error":
      return (
        <div className="rounded-cg-md bg-cg-del-bg px-3 py-2 font-mono text-small leading-[1.6] text-cg-del-fg" role="alert">
          <strong>{output.name}</strong>
          {output.message ? `: ${output.message}` : null}
          {output.trace ? <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">{output.trace}</pre> : null}
        </div>
      );
    case "note":
      return <p className="text-small text-cg-muted">{output.text}</p>;
  }
}

function Cell({ cell, language }: { cell: NotebookCell; language: string }) {
  if (cell.kind === "markdown") {
    return (
      <div className="px-1 text-ui leading-6 text-cg-ink">
        <Markdown text={cell.source} />
      </div>
    );
  }
  if (cell.kind === "raw") {
    return <pre className="px-1 font-mono text-small whitespace-pre-wrap text-cg-muted-strong">{cell.source}</pre>;
  }
  return (
    <div className="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-x-3 gap-y-2">
      <span className="pt-3 text-right font-mono text-small text-cg-accent" title="Execution count">
        [{cell.count ?? " "}]
      </span>
      <Code language={language} source={cell.source} />
      {cell.outputs.length > 0 ? (
        <>
          <span className="pt-0.5 text-right font-mono text-small text-cg-muted">out</span>
          <div className="flex min-w-0 flex-col gap-2 px-1">
            {cell.outputs.map((output, index) => (
              <Output key={index} output={output} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * A Jupyter notebook as it reads: markdown cells rendered, code cells coloured, and what they
 * printed or drew under them. It only shows: nothing in the notebook is run, HTML outputs are
 * shown as their text, and the file itself is still edited as JSON.
 */
export function NotebookView({ text }: { text: string }) {
  const parsed = useMemo(() => parseNotebook(text), [text]);
  if (!parsed.ok) {
    return (
      <p className="px-6 py-8 text-ui text-cg-muted-strong" role="status">
        {parsed.error}
      </p>
    );
  }
  const { cells, language, format } = parsed.notebook;
  return (
    <div className="h-full overflow-y-auto" data-testid="notebook">
      <div className="mx-auto flex max-w-[960px] flex-col gap-5 px-6 pt-5 pb-16">
        <p className="text-small text-cg-muted">
          {cells.length} {cells.length === 1 ? "cell" : "cells"} · {language} · nbformat {format} · nothing is run here
        </p>
        {cells.length === 0 ? <p className="text-ui text-cg-muted">This notebook has no cells.</p> : null}
        {cells.map((cell, index) => (
          <Cell key={index} cell={cell} language={language} />
        ))}
      </div>
    </div>
  );
}
