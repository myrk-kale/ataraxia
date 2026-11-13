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

  it("is amber while busy or waiting, and says so in words", () => {
    for (const status of ["starting", "working", "waiting-permission", "stopping"] as const) {
      const html = render(status);
      expect(html).toContain("bg-cg-amber");
      expect(html).not.toContain("animate");
    }
    expect(render("waiting-permission")).toContain("Needs approval");
  });

  it("is red when stopped or failed, with the word as well as the colour", () => {
    expect(render("failed")).toContain("bg-cg-red");
    expect(render("stopped")).toContain("bg-cg-red");
    expect(render("failed")).toContain("Failed");
  });
});
