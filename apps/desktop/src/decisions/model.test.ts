import { describe, expect, it } from "vitest";
import type { Artifact, Decision } from "../lib/insights";
import { ago, buildTimeline, countByTab, filterDecisions, generationLabel, generationState, openedBy, orderDecisions, refLabel } from "./model";

const decision = (seq: number, state: Decision["state"]) => ({ id: String(seq), seq, state }) as unknown as Decision;

describe("decisions model", () => {
  it("lists the newest first, like an issue list", () => {
    const ordered = orderDecisions([decision(1, "approved"), decision(3, "pending"), decision(2, "superseded")]);
    expect(ordered.map((item) => item.seq)).toEqual([3, 2, 1]);
  });

  it("splits open from closed and filters by every word typed", () => {
    const list = [
      { ...decision(1, "approved"), title: "Hash tokens", summary: "", kind: "security" },
      { ...decision(2, "pending"), title: "Retry locally", summary: "no new dependency", kind: "dependencies" },
      { ...decision(3, "rejected"), title: "Cache tokens", summary: "", kind: "performance" },
      { ...decision(4, "pending"), title: "Return 202", summary: "", kind: "api-contract" },
    ] as unknown as Decision[];
    expect(countByTab(list)).toEqual({ open: 2, closed: 2 });
    expect(filterDecisions(list, "open", "").map((item) => item.seq)).toEqual([4, 2]);
    expect(filterDecisions(list, "closed", "tokens").map((item) => item.seq)).toEqual([3, 1]);
    expect(filterDecisions(list, "open", "no dependency").map((item) => item.seq)).toEqual([2]);
    expect(filterDecisions(list, "open", "#4").map((item) => item.seq)).toEqual([4]);
    expect(filterDecisions(list, "closed", "security").map((item) => item.seq)).toEqual([1]);
  });

  it("says how long ago, and who opened it", () => {
    const now = Date.parse("2026-11-12T12:00:00Z");
    expect(ago("2026-11-12T11:59:40Z", now)).toBe("just now");
    expect(ago("2026-11-12T11:55:00Z", now)).toBe("5 minutes ago");
    expect(ago("2026-11-12T11:00:00Z", now)).toBe("1 hour ago");
    expect(ago("2026-11-09T12:00:00Z", now)).toBe("3 days ago");
    expect(ago("nonsense", now)).toBe("");
    expect(openedBy({ opened_by: "you" })).toBe("you");
    expect(openedBy({ opened_by: "agent" })).toBe("the agent in chat");
    expect(openedBy({ opened_by: "claude · sonnet" })).toBe("claude · sonnet");
    expect(openedBy({ opened_by: "" })).toBe("the agent");
  });

  it("puts comments, commits and verdicts in the order they happened", () => {
    const timeline = buildTimeline({
      messages: [{ id: "m", created_at: "2026-01-02T00:00:00Z" }] as never,
      commits: [{ rev: "abc", created_at: "2026-01-03T00:00:00Z" }] as never,
      revisions: [
        { reason: "created", created_at: "2026-01-01T00:00:00Z" },
        { reason: "state:approved", created_at: "2026-01-04T00:00:00Z" },
        { reason: "seen-again", created_at: "2026-01-05T00:00:00Z" },
      ] as never,
    });
    expect(timeline.map((event) => event.kind)).toEqual(["message", "commit", "state"]);
    expect(timeline[2]).toMatchObject({ text: "You approved this decision" });
  });

  it("reports where the newest request for decisions stands", () => {
    const run = (status: Artifact["status"], updated: string, provenance: Record<string, unknown> = {}) =>
      ({ kind: "decision", status, updated_at: updated, provenance, error: status === "failed" ? "boom" : null }) as unknown as Artifact;
    expect(generationState([]).kind).toBe("idle");
    const working = generationState([run("running", "2026-01-02", { provider: "claude", model: "sonnet" })]);
    expect(working.kind === "working" && working.label).toBe("claude · sonnet");
    const failed = generationState([run("failed", "2026-01-02")]);
    expect(failed.kind === "failed" && failed.message).toBe("boom");
    // A newer successful run hides an older failure.
    expect(generationState([run("failed", "2026-01-01"), run("ready", "2026-01-02")]).kind).toBe("idle");
    expect(generationState([{ kind: "flow", status: "running", updated_at: "x", provenance: {} } as unknown as Artifact]).kind).toBe("idle");
    expect(generationLabel({ provenance: {} })).toBe("the agent");
  });

  it("writes code references the way editors do", () => {
    expect(refLabel({ path: "a.ts", start_line: null, end_line: null })).toBe("a.ts");
    expect(refLabel({ path: "a.ts", start_line: 4, end_line: 4 })).toBe("a.ts:4");
    expect(refLabel({ path: "a.ts", start_line: 4, end_line: 9 })).toBe("a.ts:4-9");
  });
});
