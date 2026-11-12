import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProviderDescriptor, SessionOptions } from "../lib/agent";
import { SessionSettings } from "./SessionSettings";

function provider(settings: Partial<ProviderDescriptor["settings"]>): ProviderDescriptor {
  return {
    kind: "claude",
    display_name: "Claude Code",
    available: true,
    detail: null,
    settings: {
      configurable: true,
      models: [],
      efforts: [],
      custom_model: false,
      dynamic: false,
      agents: false,
      ...settings,
    },
  };
}

function options(extra: Partial<SessionOptions> = {}): SessionOptions {
  return { models: [], default_model: null, efforts: [], agents: [], ...extra };
}

function render(
  descriptor: ProviderDescriptor | null,
  state: { model?: string | null; effort?: string | null; agent?: string | null } = {},
  live: SessionOptions | null = null,
) {
  return renderToStaticMarkup(
    <SessionSettings
      agent={state.agent ?? null}
      disabled={false}
      effort={state.effort ?? null}
      model={state.model ?? null}
      options={live}
      provider={descriptor}
      onChange={() => {}}
    />,
  );
}

describe("SessionSettings", () => {
  it("offers a default plus the provider presets and efforts", () => {
    const html = render(
      provider({
        models: [{ id: "opus", label: "Opus", efforts: [] }],
        efforts: ["low", "xhigh"],
      }),
      { model: "opus", effort: "xhigh" },
    );
    expect(html).toContain('aria-label="Model"');
    expect(html).toContain('aria-label="Reasoning effort"');
    expect(html).toContain("Default model");
    expect(html).toContain("Opus");
    expect(html).toContain("Extra high");
  });

  it("prefers the models the live session reports over the presets", () => {
    const html = render(
      provider({ dynamic: true, models: [], efforts: ["low"] }),
      {},
      options({
        models: [{ id: "gpt-6.1-sol", label: "GPT 6.1 Sol", efforts: ["low", "medium"] }],
        default_model: "gpt-6.1-sol",
      }),
    );
    expect(html).toContain("GPT 6.1 Sol");
    expect(html).toContain("Medium");
  });

  it("lists the effort levels of the chosen model only", () => {
    const live = options({
      models: [
        { id: "big", label: "Big", efforts: ["low", "high"] },
        { id: "small", label: "Small", efforts: ["low"] },
      ],
    });
    const html = render(provider({ dynamic: true }), { model: "small" }, live);
    expect(html).toContain('aria-label="Reasoning effort"');
    expect(html).not.toContain(">High<");
  });

  it("shows an agent picker only when the provider and session offer agents", () => {
    const agents = [{ id: "reviewer", label: "reviewer", description: "Reviews diffs" }];
    const withAgents = render(provider({ agents: true }), { agent: "reviewer" }, options({ agents }));
    expect(withAgents).toContain('aria-label="Agent"');
    expect(withAgents).toContain("Default agent");
    expect(withAgents).toContain("Reviews diffs");
    expect(render(provider({ agents: true }), {}, options())).not.toContain('aria-label="Agent"');
    expect(render(provider({ agents: false }), {}, options({ agents }))).not.toContain(
      'aria-label="Agent"',
    );
  });

  it("keeps a saved agent, model or effort selectable even if it is no longer listed", () => {
    const html = render(
      provider({ agents: true, custom_model: true, efforts: ["low"] }),
      { model: "my-model-1", agent: "gone", effort: "ultra" },
      options({ agents: [{ id: "x", label: "x", description: null }] }),
    );
    expect(html).toContain("my-model-1");
    expect(html).toContain("gone");
    expect(html).toContain("Ultra");
    expect(html).toContain('aria-label="Custom model id"');
  });

  it("hides the effort picker when the provider has no effort levels", () => {
    expect(render(provider({ efforts: [] }))).not.toContain("Reasoning effort");
  });

  it("explains when the provider cannot be configured", () => {
    const html = render(provider({ configurable: false }));
    expect(html).toContain("Model set by the provider");
    expect(html).not.toContain('aria-label="Model"');
  });
});
