import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuietSelect } from "./QuietSelect";

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
