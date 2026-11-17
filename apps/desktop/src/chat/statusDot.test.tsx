import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionStatus } from "../lib/workspace";
import { StatusDot } from "./StatusDot";

function render(status: SessionStatus): string {
  return renderToStaticMarkup(<StatusDot status={status} />);
}

describe("StatusDot", () => {
  it("shows a green dot when ready or idle", () => {
    expect(render("ready")).toContain("bg-cg-green");
    expect(render("idle")).toContain('aria-label="Idle"');
  });

  it("is amber while busy or waiting, with an accessible label", () => {
    for (const status of ["starting", "working", "waiting-permission", "stopping"] as const) {
      const html = render(status);
      expect(html).toContain("bg-cg-amber");
      expect(html).not.toContain("animate");
    }
    expect(render("waiting-permission")).toContain('aria-label="Needs approval"');
    expect(render("working")).not.toContain(">Working<");
  });

  it("is red when stopped or failed, with an accessible label", () => {
    expect(render("failed")).toContain("bg-cg-red");
    expect(render("stopped")).toContain("bg-cg-red");
    expect(render("failed")).toContain('aria-label="Failed"');
  });
});
