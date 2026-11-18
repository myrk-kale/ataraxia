import { describe, expect, it } from "vitest";
import type { Decision } from "../lib/insights";
import { canReject, cardLabel, reviewOrder, tally } from "./review";

function decision(seq: number, state: Decision["state"]): Decision {
  return {
    id: `d${seq}`,
    session_id: "s",
    checkpoint_id: "c",
    artifact_id: null,
    seq,
    kind: "behavior",
    title: `Decision ${seq}`,
    summary: "",
    context: "",
    rationale: "",
    alternatives: [],
    refs: [],
    state,
    version: 1,
    superseded_by: null,
    opened_by: "",
    created_at: "",
    updated_at: "",
  };
}

describe("a decision review", () => {
  const list = [decision(1, "approved"), decision(2, "pending"), decision(3, "superseded"), decision(4, "rejected"), decision(5, "pending")];

  it("shows the open decisions first, in order, and never a superseded one", () => {
    expect(reviewOrder(list).map((item) => item.seq)).toEqual([2, 5, 1, 4]);
  });

  it("counts what is left and what was decided", () => {
    expect(tally(list)).toEqual({ total: 4, pending: 2, approved: 1, rejected: 1 });
    expect(cardLabel(tally(list))).toBe("2 decisions to review");
    expect(cardLabel(tally([decision(1, "approved"), decision(2, "rejected")]))).toBe("Reviewed: 1 approved, 1 rejected");
    expect(cardLabel(tally([decision(1, "pending")]))).toBe("1 decision to review");
  });

  it("only rejects with a comment", () => {
    expect(canReject("")).toBe(false);
    expect(canReject("   ")).toBe(false);
    expect(canReject("Keep the old endpoint")).toBe(true);
  });
});
