import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolItem } from "../lib/agent";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

function tool(overrides: Partial<ToolItem>): ToolItem {
  return {
    kind: "tool",
    callId: "c1",
    turnId: "t1",
    name: "Bash",
    input: "",
    output: null,
    status: "running",
    ...overrides,
  };
}

describe("Markdown", () => {
  it("renders emphasis, inline code and fenced blocks", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"**bold** and `code`\n\n```\nlet x = 1;\n```"} />,
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code");
    expect(html).toContain("<pre");
    expect(html).toContain("let x = 1;");
  });

  it("does not render raw HTML from the model", () => {
    const html = renderToStaticMarkup(<Markdown text={"<script>alert(1)</script>"} />);
    expect(html).not.toContain("<script>");
  });

  it("renders GFM tables", () => {
    const html = renderToStaticMarkup(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |"} />);
    expect(html).toContain("<table");
  });
});

describe("ToolCard", () => {
  it("shows the name and a one-line summary of the input", () => {
    const html = renderToStaticMarkup(
      <ToolCard defaultOpen tool={tool({ input: '{"command":"git status"}' })} />,
    );
    expect(html).toContain("Bash");
    expect(html).toContain("git status");
    expect(html).toContain("Waiting for the result");
  });

  it("puts neither the input nor the output in the page while it is closed", () => {
    const html = renderToStaticMarkup(
      <ToolCard
        tool={tool({
          name: "Edit",
          input: '{"file_path":"/w/a.rs","old_string":"a-long-old-text","new_string":"b"}',
          output: "the-whole-output",
          status: "done",
        })}
      />,
    );
    // What the closed card shows: the name and the one-line summary.
    expect(html).toContain("Edit");
    expect(html).not.toContain("the-whole-output");
    expect(html).not.toContain("a-long-old-text");
    expect(html).not.toContain("bg-cg-add-bg");
    expect(html).not.toContain("<pre");
  });

  it("renders output and a colored diff for edits", () => {
    const html = renderToStaticMarkup(
      <ToolCard
        defaultOpen
        tool={tool({
          name: "Edit",
          input: '{"file_path":"/w/a.rs","old_string":"a","new_string":"b"}',
          output: "done",
          status: "done",
        })}
      />,
    );
    expect(html).toContain("done");
    expect(html).toContain("bg-cg-add-bg");
    expect(html).toContain("bg-cg-del-bg");
  });
});
