import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { filterOptions, QuietSelect } from "./QuietSelect";

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", disabled: true, hint: "not installed" },
];

describe("QuietSelect", () => {
  it("shows the selected label on the trigger and lists every option", () => {
    const html = renderToStaticMarkup(
      <QuietSelect aria-label="Pick" options={OPTIONS} value="a" onChange={() => {}} />,
    );
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
  });

  it("marks unavailable options as disabled and falls back to the placeholder", () => {
    const html = renderToStaticMarkup(
      <QuietSelect
        aria-label="Pick"
        options={OPTIONS}
        placeholder="nothing"
        value="missing"
        onChange={() => {}}
      />,
    );
    expect(html).toContain("nothing");
    expect(html).toContain('title="not installed"');
    expect(html).toContain("disabled");
  });

  it("renders actions under a divider", () => {
    const html = renderToStaticMarkup(
      <QuietSelect
        actions={[{ label: "Open folder…", onSelect: () => {} }]}
        aria-label="Pick"
        options={OPTIONS}
        value="a"
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Open folder…");
    expect(html).toContain("border-t");
  });
});

describe("filterOptions", () => {
  const options = [
    { value: "", label: "Default model" },
    { value: "openai/gpt-4.1", label: "openai/GPT-4.1 mini" },
    { value: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Fast daily coder" },
  ];

  it("returns everything for an empty query", () => {
    expect(filterOptions(options, "")).toEqual(options);
    expect(filterOptions(options, "   ")).toEqual(options);
  });

  it("matches case-insensitively on label, value and hint", () => {
    expect(filterOptions(options, "GPT").map((item) => item.value)).toEqual(["openai/gpt-4.1"]);
    expect(filterOptions(options, "anthropic").map((item) => item.label)).toEqual([
      "Claude Sonnet 5.5",
    ]);
    expect(filterOptions(options, "daily").map((item) => item.label)).toEqual([
      "Claude Sonnet 5.5",
    ]);
  });

  it("requires every word to match, in any order", () => {
    expect(filterOptions(options, "mini gpt").map((item) => item.value)).toEqual([
      "openai/gpt-4.1",
    ]);
    expect(filterOptions(options, "mini sonnet")).toEqual([]);
  });
});

describe("QuietSelect search", () => {
  it("shows a search box only when asked", () => {
    const base = { "aria-label": "Model", options: OPTIONS, value: "a", onChange: () => {} };
    expect(renderToStaticMarkup(<QuietSelect {...base} searchable />)).toContain(
      'aria-label="Search model"',
    );
    expect(renderToStaticMarkup(<QuietSelect {...base} />)).not.toContain("Search model");
  });
});

