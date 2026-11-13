import { describe, expect, it } from "vitest";
import type { ChatItem } from "../lib/agent";
import { contextLabel, doneInAtaraxia, lastAnswer, withoutActions } from "./answer";
import { decodePick, encodePick, modelChoices, startingChoice } from "./models";

const msg = (role: "user" | "assistant", text: string): ChatItem => ({ kind: "message", id: text, role, text, turnId: null });

describe("btw helpers", () => {
  it("takes the assistant text of the last turn only", () => {
    expect(
      lastAnswer([msg("user", "q1"), msg("assistant", "a1"), msg("user", "q2"), msg("assistant", "a2"), msg("assistant", "a2b")]),
    ).toBe("a2\n\na2b");
    expect(lastAnswer([msg("user", "q")])).toBe("");
    expect(lastAnswer([])).toBe("");
  });

  it("labels the context like an editor location", () => {
    expect(contextLabel(null)).toBe("No selection");
    expect(contextLabel({ label: "Decision: x" })).toBe("Decision: x");
    expect(contextLabel({ label: "f", path: "a.ts" })).toBe("a.ts");
    expect(contextLabel({ label: "f", path: "a.ts", startLine: 4, endLine: 4 })).toBe("a.ts:4");
    expect(contextLabel({ label: "f", path: "a.ts", startLine: 4, endLine: 9 })).toBe("a.ts:4-9");
  });

  it("hides the machine block at the end of an answer, even while it is still streaming", () => {
    const block = '```ataraxia-actions\n[{"type":"comment","path":"a.py","unit":"f","text":"x"}]\n```';
    expect(withoutActions(`I commented on f.\n\n${block}`)).toBe("I commented on f.");
    expect(withoutActions('I will do it.\n\n```ataraxia-actions\n[{"type":"com')).toBe("I will do it.");
    expect(withoutActions("Nothing to do here.")).toBe("Nothing to do here.");
  });

  it("lists what was done in Ataraxia from the summary", () => {
    const summary = "Answer.\n\nDone in Ataraxia:\n- Commented on `f` (a.py:1)\n- Could not comment: nope";
    expect(doneInAtaraxia(summary)).toEqual(["Commented on `f` (a.py:1)", "Could not comment: nope"]);
    expect(doneInAtaraxia("Just an answer.")).toEqual([]);
    expect(doneInAtaraxia(null)).toEqual([]);
  });
});

describe("the model a BTW runs on", () => {
  const descriptor = (kind: string, name: string, available: boolean, models: string[]) =>
    ({ kind, display_name: name, available, detail: available ? null : "Not installed", settings: { models: models.map((id) => ({ id, label: id.toUpperCase(), efforts: [] })) } }) as never;
  const providers = [descriptor("claude", "Claude Code", true, ["sonnet", "opus"]), descriptor("codex", "Codex", true, ["gpt"]), descriptor("opencode", "OpenCode", false, [])];

  it("lists each provider's default and models, and marks one that is not installed", () => {
    const options = modelChoices(providers, { provider: "claude" }, [], false);
    expect(options.map((o) => o.label)).toEqual([
      "Claude Code · Default",
      "Claude Code · SONNET",
      "Claude Code · OPUS",
      "Codex · Default",
      "Codex · GPT",
      "OpenCode · Default",
    ]);
    expect(options.at(-1)).toMatchObject({ disabled: true, hint: "Not installed" });
  });

  it("uses the models the chat's own provider reports, when it reports any", () => {
    const live = [{ id: "sonnet-9", label: "Sonnet 9", efforts: [] }];
    const labels = modelChoices(providers, { provider: "claude" }, live, false).map((o) => o.label);
    expect(labels).toContain("Claude Code · Sonnet 9");
    expect(labels).not.toContain("Claude Code · OPUS");
    expect(labels).toContain("Codex · GPT");
  });

  it("round-trips a choice and starts from the last one, else from the chat's provider", () => {
    expect(decodePick(encodePick({ provider: "claude", model: "sonnet" }))).toEqual({ provider: "claude", model: "sonnet" });
    expect(decodePick(encodePick({ provider: "codex", model: null }))).toEqual({ provider: "codex", model: null });
    const options = modelChoices(providers, { provider: "claude" }, [], false);
    expect(startingChoice(options, { provider: "claude" }, "codex::gpt")).toBe("codex::gpt");
    expect(startingChoice(options, { provider: "claude" }, "gone::x")).toBe("claude::");
    expect(startingChoice(options, { provider: "claude" }, "opencode::")).toBe("claude::");
    expect(startingChoice([], null, null)).toBe("");
  });
});
