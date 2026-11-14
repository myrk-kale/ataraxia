// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { codeText, languageOf, tableCopy, tableToTsv } from "./markdownCopy";
import { luminance, mermaidTheme } from "./mermaidTheme";

function table(html: string): HTMLTableElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.querySelector("table") as HTMLTableElement;
}

describe("markdown copy", () => {
  it("copies a table as tab-separated rows, header included", () => {
    const found = table(
      "<table><thead><tr><th>Name</th><th>Role</th></tr></thead><tbody><tr><td>Ana</td><td>dev</td></tr><tr><td>Bo</td><td>ops</td></tr></tbody></table>",
    );
    expect(tableToTsv(found)).toBe("Name\tRole\nAna\tdev\nBo\tops");
  });

  it("keeps a cell on one line so a paste does not split it", () => {
    const found = table("<table><tr><td>two\n  lines\twith tab</td><td> x </td></tr></table>");
    expect(tableToTsv(found)).toBe("two lines with tab\tx");
  });

  it("offers the table as HTML too, for documents and spreadsheets", () => {
    const copy = tableCopy(table("<table><tr><td>a</td></tr></table>"));
    expect(copy.html).toContain("<table>");
    expect(copy.text).toBe("a");
  });

  it("reads the language of a fenced block and the code without its closing newline", () => {
    expect(languageOf("language-Mermaid")).toBe("mermaid");
    expect(languageOf("foo language-ts bar")).toBe("ts");
    expect(languageOf(undefined)).toBeNull();
    expect(languageOf("hljs")).toBeNull();
    expect(codeText("let a = 1;\n")).toBe("let a = 1;");
    expect(codeText(["a", "b\n"])).toBe("ab");
    expect(codeText(undefined)).toBe("");
  });
});

describe("mermaid theme", () => {
  const tokens: Record<string, string> = {
    "--cg-panel": "#161715",
    "--cg-ink": "#e8e9e6",
    "--cg-tint": "rgb(30, 31, 29)",
    "--cg-line-strong": "color-mix(in srgb, red, blue)",
  };
  const read = (name: string) => tokens[name] ?? "";

  it("takes its colours from the app's tokens and knows a dark panel", () => {
    const theme = mermaidTheme(read, "Inter");
    expect(theme.dark).toBe(true);
    expect(theme.variables.background).toBe("#161715");
    expect(theme.variables.primaryTextColor).toBe("#e8e9e6");
    expect(theme.variables.primaryColor).toBe("rgb(30, 31, 29)");
    expect(theme.variables.fontFamily).toBe("Inter");
  });

  it("falls back to the default for a colour notation it cannot compute with", () => {
    expect(mermaidTheme(read, "x").variables.primaryBorderColor).toBe("#dbdad5");
    expect(mermaidTheme(() => "", "x").dark).toBe(false);
  });

  it("measures light and dark", () => {
    expect(luminance("#ffffff")).toBeGreaterThan(0.9);
    expect(luminance("#000")).toBeLessThan(0.01);
    expect(luminance("rgb(255, 255, 255)")).toBeGreaterThan(0.9);
  });
});
