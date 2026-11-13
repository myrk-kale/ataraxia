import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SubagentView } from "../lib/agent";
import { SubagentBar } from "./SubagentBar";

const SUBAGENTS: SubagentView[] = [
  { id: "a", title: "Explore the repo", status: "done", items: [] },
  { id: "b", title: "Review the diff", status: "running", items: [] },
  { id: "c", title: "Run the tests", status: "failed", items: [] },
];

function render(selected: string | null, busy = false, subagents = SUBAGENTS) {
  return renderToStaticMarkup(
    <SubagentBar
      busy={busy}
      mainLabel="main"
      selected={selected}
      subagents={subagents}
      onSelect={() => {}}
      onStop={() => {}}
    />,
  );
}

describe("SubagentBar", () => {
  it("renders nothing without subagents", () => {
    expect(render(null, false, [])).toBe("");
  });

  it("lists the main conversation and every subagent with its state", () => {
    const html = render(null);
    expect(html).toContain("main");
    expect(html).toContain("Explore the repo");
    expect(html).toContain("Review the diff");
    expect(html).toContain("text-cg-green");
    expect(html).toContain("animate-spin");
    expect(html).toContain("text-cg-red");
    expect(html).toContain("working");
    expect(html).toContain("failed");
  });

  it("marks the open conversation as current", () => {
    expect(render("b").match(/aria-current="true"/g)).toHaveLength(1);
    const main = render(null);
    expect(main.indexOf('aria-current="true"')).toBeLessThan(main.indexOf("Explore the repo"));
  });

  it("offers Stop only while a turn is running", () => {
    expect(render("a", true)).toContain('aria-label="Stop"');
    expect(render("a", false)).not.toContain('aria-label="Stop"');
  });
});
