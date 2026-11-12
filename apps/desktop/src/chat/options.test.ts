import { describe, expect, it } from "vitest";
import type { ProviderDescriptor, SessionOptions } from "../lib/agent";
import { effortAfterModelChange, effortsFor, modelChoices } from "./options";

function provider(dynamic: boolean, efforts: string[] = []): ProviderDescriptor {
  return {
    kind: "codex",
    display_name: "Codex",
    available: true,
    detail: null,
    settings: {
      configurable: true,
      models: [{ id: "preset", label: "Preset", efforts: [] }],
      efforts,
      custom_model: true,
      dynamic,
      agents: true,
    },
  };
}

const live: SessionOptions = {
  models: [
    { id: "big", label: "Big", efforts: ["low", "high"] },
    { id: "small", label: "Small", efforts: ["low"] },
    { id: "plain", label: "Plain", efforts: [] },
  ],
  default_model: "big",
  efforts: ["low", "high"],
  agents: [],
};

describe("modelChoices", () => {
  it("uses the live list, falling back to the presets", () => {
    expect(modelChoices(provider(true), live).map((item) => item.id)).toEqual([
      "big",
      "small",
      "plain",
    ]);
    expect(modelChoices(provider(true), null).map((item) => item.id)).toEqual(["preset"]);
    expect(modelChoices(null, null)).toEqual([]);
  });
});

describe("effortsFor", () => {
  it("returns the levels of the chosen model, or of the default model when none is chosen", () => {
    expect(effortsFor(provider(true), live, "small")).toEqual(["low"]);
    expect(effortsFor(provider(true), live, null)).toEqual(["low", "high"]);
  });

  it("falls back to the session list and then to the provider's fixed list", () => {
    expect(effortsFor(provider(true), live, "plain")).toEqual(["low", "high"]);
    expect(effortsFor(provider(false, ["max"]), null, "whatever")).toEqual(["max"]);
    expect(effortsFor(null, null, null)).toEqual([]);
  });
});

describe("effortAfterModelChange", () => {
  it("keeps a level the new model supports and drops one it does not", () => {
    expect(effortAfterModelChange(provider(true), live, "big", "high")).toBe("high");
    expect(effortAfterModelChange(provider(true), live, "small", "high")).toBeNull();
  });

  it("resets for providers whose levels depend on the model, keeps it for fixed lists", () => {
    expect(effortAfterModelChange(provider(true), live, "plain", "high")).toBeNull();
    expect(effortAfterModelChange(provider(false, ["low", "high"]), null, "opus", "high")).toBe(
      "high",
    );
  });

  it("stays empty when no effort was set", () => {
    expect(effortAfterModelChange(provider(true), live, "big", null)).toBeNull();
  });
});
