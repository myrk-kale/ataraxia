// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./monacoSetup", () => ({ loadMonaco: () => new Promise(() => undefined) }));
vi.mock("../app/appearance/store", () => ({ useAppearance: () => ({ monacoTheme: "ataraxia-light" }) }));

import { NotebookView } from "./NotebookView";

const notebook = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { language: "python" } },
  cells: [
    { cell_type: "markdown", source: ["# Analysis\n", "Some **notes**."] },
    {
      cell_type: "code",
      execution_count: 4,
      source: "total = 1 + 1\nprint(total)",
      outputs: [
        { output_type: "stream", name: "stdout", text: "2\n" },
        { output_type: "display_data", data: { "image/png": "iVBORw0KGgo=" } },
        { output_type: "error", ename: "KeyError", evalue: "'x'", traceback: ["\u001b[31mKeyError\u001b[0m"] },
      ],
    },
  ],
});

describe("a notebook in the editor", () => {
  it("shows markdown cells rendered and code cells with their outputs", () => {
    const html = renderToStaticMarkup(<NotebookView text={notebook} />);
    expect(html).toContain("2 cells");
    expect(html).toContain("<h1");
    expect(html).toContain("Analysis");
    expect(html).toContain("<strong>notes</strong>");
    expect(html).toContain("[4]");
    expect(html).toContain("total = 1 + 1");
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).toContain("KeyError");
    expect(html).not.toContain("\u001b");
  });

  it("explains a file that is not a notebook instead of showing nothing", () => {
    expect(renderToStaticMarkup(<NotebookView text="{ broken" />)).toContain("not valid JSON");
  });
});
