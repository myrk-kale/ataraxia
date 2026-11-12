import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionStatus } from "../lib/workspace";
import { StatusDot } from "./StatusDot";

function render(status: SessionStatus): string {
  return renderToStaticMarkup(<StatusDot status={status} />);
}

describe("StatusDot", () => {
  it("is green when the agent is ready", () => {
    expect(render("ready")).toContain("bg-cg-green");
  });

  it("is a pulsing yellow while busy or waiting", () => {
    for (const status of ["starting", "working", "waiting-permission", "stopping"] as const) {
      const html = render(status);
      expect(html).toContain("bg-cg-amber");
      expect(html).toContain("cg-pulse");
    }
  });

  it("is red when stopped or failed, with an accessible label", () => {
    expect(render("failed")).toContain("bg-cg-red");
    expect(render("stopped")).toContain("bg-cg-red");
    expect(render("failed")).toContain('aria-label="Failed"');
  });
});
