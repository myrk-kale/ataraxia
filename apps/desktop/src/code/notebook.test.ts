import { describe, expect, it } from "vitest";
import { htmlToText, joinLines, parseNotebook, stripAnsi } from "./notebook";

const notebook = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { language_info: { name: "Python" } },
  cells: [
    { cell_type: "markdown", source: ["# Title\n", "text"] },
    {
      cell_type: "code",
      execution_count: 3,
      source: "print(1)\nx",
      outputs: [
        { output_type: "stream", name: "stdout", text: ["1\n"] },
        { output_type: "execute_result", data: { "text/plain": ["2"], "text/html": ["<b>2</b>"] }, execution_count: 3 },
        { output_type: "display_data", data: { "image/png": "iVBO\nRw0K", "text/plain": "<Figure>" } },
        { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["\u001b[0;31mValueError\u001b[0m: bad"] },
      ],
    },
    { cell_type: "raw", source: "raw text" },
    { cell_type: "mystery", source: "?" },
  ],
};

describe("reading a notebook", () => {
  it("reads markdown, code with its outputs, and raw cells; unknown cells are dropped", () => {
    const parsed = parseNotebook(JSON.stringify(notebook));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.notebook.language).toBe("python");
    expect(parsed.notebook.format).toBe("4.5");
    expect(parsed.notebook.cells.map((cell) => cell.kind)).toEqual(["markdown", "code", "raw"]);
    expect(parsed.notebook.cells[0]).toEqual({ kind: "markdown", source: "# Title\ntext" });
    const code = parsed.notebook.cells[1];
    expect(code.kind === "code" && code.count).toBe(3);
  });

  it("picks the best output it can show: images first, then text, never running HTML", () => {
    const parsed = parseNotebook(JSON.stringify(notebook));
    if (!parsed.ok) throw new Error("not parsed");
    const code = parsed.notebook.cells[1];
    if (code.kind !== "code") throw new Error("not code");
    expect(code.outputs[0]).toEqual({ kind: "text", text: "1\n", stream: "stdout" });
    expect(code.outputs[1]).toEqual({ kind: "text", text: "2" });
    expect(code.outputs[2]).toEqual({ kind: "image", mime: "image/png", src: "data:image/png;base64,iVBORw0K" });
    expect(code.outputs[3]).toEqual({ kind: "error", name: "ValueError", message: "bad", trace: "ValueError: bad" });
  });

  it("turns an HTML-only output into text and notes what it cannot show", () => {
    const parsed = parseNotebook(
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            source: "",
            outputs: [
              { output_type: "display_data", data: { "text/html": "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table><script>alert(1)</script>" } },
              { output_type: "display_data", data: { "application/vnd.jupyter.widget-view+json": {} } },
            ],
          },
        ],
      }),
    );
    if (!parsed.ok) throw new Error("not parsed");
    const code = parsed.notebook.cells[0];
    if (code.kind !== "code") throw new Error("not code");
    expect(code.outputs[0]).toEqual({ kind: "text", text: "a\tb\n1\t2" });
    expect(code.outputs[1].kind).toBe("note");
  });

  it("reads old notebooks that kept cells in worksheets", () => {
    const parsed = parseNotebook(
      JSON.stringify({ nbformat: 3, worksheets: [{ cells: [{ cell_type: "code", input: ["1+1"], prompt_number: 2, outputs: [] }] }] }),
    );
    if (!parsed.ok) throw new Error("not parsed");
    expect(parsed.notebook.cells).toEqual([{ kind: "code", source: "1+1", count: 2, outputs: [] }]);
  });

  it("says why a file is not shown as a notebook", () => {
    expect(parseNotebook("{ not json")).toEqual({ ok: false, error: expect.stringContaining("not valid JSON") });
    expect(parseNotebook("[]")).toEqual({ ok: false, error: expect.stringContaining("not a notebook") });
    expect(parseNotebook("{}")).toEqual({ ok: false, error: expect.stringContaining("no cells") });
    // An empty notebook is a notebook.
    expect(parseNotebook('{"cells": []}').ok).toBe(true);
  });

  it("has small helpers that do what they say", () => {
    expect(joinLines(["a\n", "b", 3])).toBe("a\nb");
    expect(joinLines(null)).toBe("");
    expect(stripAnsi("\u001b[1;32mok\u001b[0m")).toBe("ok");
    expect(htmlToText("a&nbsp;&amp;&lt;b&gt;<br>c")).toBe("a &<b>\nc");
  });
});
