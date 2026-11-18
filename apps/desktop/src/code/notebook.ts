/** A Jupyter notebook (`.ipynb`) read into what the viewer shows. */

export type NotebookOutput =
  | { kind: "text"; text: string; stream?: "stdout" | "stderr" }
  | { kind: "image"; mime: string; src: string }
  | { kind: "markdown"; text: string }
  | { kind: "error"; name: string; message: string; trace: string }
  | { kind: "note"; text: string };

export type NotebookCell =
  | { kind: "markdown"; source: string }
  | { kind: "raw"; source: string }
  | { kind: "code"; source: string; count: number | null; outputs: NotebookOutput[] };

export type Notebook = {
  /** The language of the code cells, for colouring them. */
  language: string;
  cells: NotebookCell[];
  /** `4.5` for nbformat 4, minor 5. */
  format: string;
};

export type NotebookParse = { ok: true; notebook: Notebook } | { ok: false; error: string };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Notebook text is a string or a list of lines (which already end in newlines). */
export function joinLines(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((part): part is string => typeof part === "string").join("");
  }
  return "";
}

// ANSI colour and cursor codes that tracebacks carry.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** What a piece of HTML says, as text: enough to read a table of numbers, never to run anything. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(tr|p|div|h[1-6]|li|table|thead|tbody)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** The richest thing a mime bundle holds that the viewer can show without running anything. */
function fromBundle(data: Json): NotebookOutput | null {
  for (const mime of IMAGE_MIMES) {
    const raw = data[mime];
    if (raw !== undefined) {
      const base64 = joinLines(raw).replace(/\s+/g, "");
      if (base64) {
        return { kind: "image", mime, src: `data:${mime};base64,${base64}` };
      }
    }
  }
  const svg = data["image/svg+xml"];
  if (svg !== undefined) {
    const text = joinLines(svg);
    if (text) {
      return { kind: "image", mime: "image/svg+xml", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}` };
    }
  }
  const markdown = data["text/markdown"];
  if (markdown !== undefined) {
    return { kind: "markdown", text: joinLines(markdown) };
  }
  const plain = data["text/plain"];
  if (plain !== undefined) {
    return { kind: "text", text: stripAnsi(joinLines(plain)) };
  }
  const html = data["text/html"];
  if (html !== undefined) {
    return { kind: "text", text: htmlToText(joinLines(html)) };
  }
  const json = data["application/json"];
  if (json !== undefined) {
    return { kind: "text", text: typeof json === "string" ? json : JSON.stringify(json, null, 2) };
  }
  const latex = data["text/latex"];
  if (latex !== undefined) {
    return { kind: "text", text: joinLines(latex) };
  }
  const kinds = Object.keys(data);
  return kinds.length > 0 ? { kind: "note", text: `Output of type ${kinds.join(", ")} cannot be shown here.` } : null;
}

function readOutput(raw: unknown): NotebookOutput | null {
  if (!isObject(raw)) {
    return null;
  }
  switch (raw.output_type) {
    case "stream":
      return {
        kind: "text",
        text: stripAnsi(joinLines(raw.text)),
        stream: raw.name === "stderr" ? "stderr" : "stdout",
      };
    case "execute_result":
    case "display_data":
      return isObject(raw.data) ? fromBundle(raw.data) : null;
    case "error": {
      const trace = Array.isArray(raw.traceback) ? stripAnsi(raw.traceback.filter((line): line is string => typeof line === "string").join("\n")) : "";
      return {
        kind: "error",
        name: typeof raw.ename === "string" ? raw.ename : "Error",
        message: typeof raw.evalue === "string" ? raw.evalue : "",
        trace,
      };
    }
    default:
      return null;
  }
}

function readCell(raw: unknown): NotebookCell | null {
  if (!isObject(raw)) {
    return null;
  }
  const source = joinLines(raw.source);
  switch (raw.cell_type) {
    case "markdown":
      return { kind: "markdown", source };
    case "code": {
      const outputs = Array.isArray(raw.outputs)
        ? raw.outputs.map(readOutput).filter((output): output is NotebookOutput => output !== null)
        : [];
      const count = typeof raw.execution_count === "number" ? raw.execution_count : null;
      return { kind: "code", source, count, outputs };
    }
    case "raw":
      return { kind: "raw", source };
    default:
      return null;
  }
}

/** nbformat 3 kept its cells in worksheets and called code `input`; read what can be read of it. */
function legacyCells(root: Json): unknown[] {
  const sheets = Array.isArray(root.worksheets) ? root.worksheets : [];
  return sheets.flatMap((sheet) => (isObject(sheet) && Array.isArray(sheet.cells) ? sheet.cells : []));
}

/**
 * Reads notebook JSON. A notebook that is not valid JSON, or has no cells, says why instead of
 * showing nothing, so the file can still be opened as text.
 */
export function parseNotebook(text: string): NotebookParse {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { ok: false, error: "This file is not valid JSON, so it cannot be shown as a notebook." };
  }
  if (!isObject(root)) {
    return { ok: false, error: "This file is not a notebook." };
  }
  const rawCells = Array.isArray(root.cells) ? root.cells : legacyCells(root);
  if (!Array.isArray(root.cells) && rawCells.length === 0) {
    return { ok: false, error: "This file has no cells, so it is not a notebook." };
  }
  const cells = rawCells
    .map((raw) => {
      if (isObject(raw) && raw.cell_type === "code" && raw.source === undefined && raw.input !== undefined) {
        return readCell({ ...raw, source: raw.input, execution_count: raw.prompt_number });
      }
      return readCell(raw);
    })
    .filter((cell): cell is NotebookCell => cell !== null);
  const metadata = isObject(root.metadata) ? root.metadata : {};
  const info = isObject(metadata.language_info) ? metadata.language_info : {};
  const kernel = isObject(metadata.kernelspec) ? metadata.kernelspec : {};
  const language =
    (typeof info.name === "string" && info.name) || (typeof kernel.language === "string" && kernel.language) || "python";
  const minor = typeof root.nbformat_minor === "number" ? root.nbformat_minor : 0;
  return {
    ok: true,
    notebook: { language: language.toLowerCase(), cells, format: `${typeof root.nbformat === "number" ? root.nbformat : 4}.${minor}` },
  };
}
