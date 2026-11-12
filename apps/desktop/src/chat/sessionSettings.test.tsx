import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProviderDescriptor } from "../lib/agent";
import { SessionSettings } from "./SessionSettings";

function provider(settings: Partial<ProviderDescriptor["settings"]>): ProviderDescriptor {
  return {
    kind: "claude",
    display_name: "Claude Code",
    available: true,
    detail: null,
    settings: { configurable: true, models: [], efforts: [], custom_model: false, ...settings },
  };
}

function render(descriptor: ProviderDescriptor | null, model: string | null, effort: string | null) {
  return renderToStaticMarkup(
    <SessionSettings
      disabled={false}
      effort={effort}
      model={model}
      provider={descriptor}
      onChange={() => {}}
    />,
  );
}

describe("SessionSettings", () => {
  it("offers a default plus the provider presets and efforts", () => {
    const html = render(
      provider({ models: [{ id: "opus", label: "Opus" }], efforts: ["low", "xhigh"] }),
      "opus",
      "xhigh",
    );
    expect(html).toContain('aria-label="Model"');
    expect(html).toContain('aria-label="Reasoning effort"');
    expect(html).toContain("Default model");
    expect(html).toContain("Opus");
    expect(html).toContain("Extra high");
  });

  it("keeps a custom model id selectable", () => {
    const html = render(provider({ custom_model: true, efforts: ["low"] }), "my-model-1", null);
    expect(html).toContain("my-model-1");
    expect(html).toContain('aria-label="Custom model id"');
  });

  it("hides the effort picker when the provider has no effort levels", () => {
    expect(render(provider({ efforts: [] }), null, null)).not.toContain("Reasoning effort");
  });

  it("explains when the provider cannot be configured", () => {
    const html = render(provider({ configurable: false }), null, null);
    expect(html).toContain("Model set by the provider");
    expect(html).not.toContain('aria-label="Model"');
  });
});
