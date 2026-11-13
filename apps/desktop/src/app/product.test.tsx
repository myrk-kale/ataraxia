// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suggestionsFor } from "../chat/ChatPanel";
import { ProviderMark } from "../chat/ProviderMark";
import type { ProviderDescriptor } from "../lib/agent";
import { MainChatNote } from "../btw/BtwPalette";
import { introEnabled } from "../intro/timeline";
import { Toast } from "./Toast";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { Tip } from "../ui/Overlay";
import { StateMessage } from "../ui/State";
import { StatusLabel } from "../ui/StatusLabel";
import { pickProvider, visibleProviders } from "./providers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const descriptor = (kind: ProviderDescriptor["kind"], available = true): ProviderDescriptor =>
  ({ kind, display_name: kind, available, detail: null }) as ProviderDescriptor;

describe("provider choices", () => {
  const all = [descriptor("fake"), descriptor("claude"), descriptor("codex", false), descriptor("opencode")];

  it("hides the demo provider in a release build", () => {
    expect(visibleProviders(all, null, false).map((item) => item.kind)).toEqual(["claude", "codex", "opencode"]);
  });

  it("shows it while developing, and for a chat that already runs on it", () => {
    expect(visibleProviders(all, null, true)).toHaveLength(4);
    expect(visibleProviders(all, "fake", false)).toHaveLength(4);
  });

  it("picks the remembered provider if it can run, else the first that can, else none", () => {
    const real = visibleProviders(all, null, false);
    expect(pickProvider(real, "opencode")).toBe("opencode");
    expect(pickProvider(real, "codex")).toBe("claude");
    expect(pickProvider(real, null)).toBe("claude");
    expect(pickProvider([descriptor("claude", false)], "claude")).toBeNull();
    expect(pickProvider([], null)).toBeNull();
  });
});

describe("chat suggestions", () => {
  it("name the branch when the chat is on a feature branch", () => {
    const text = suggestionsFor("ataraxia · feat/diff-target").join("|");
    expect(text).toContain("feat/diff-target");
  });

  it("name the repository on a trunk branch, and cope with no context", () => {
    expect(suggestionsFor("ataraxia · main").join("|")).toContain("tour of ataraxia");
    expect(suggestionsFor(null)).toHaveLength(3);
  });
});

describe("intro", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.matchMedia = ((query: string) => ({ matches: false, media: query })) as typeof window.matchMedia;
  });

  it("plays every time the app opens, however many times it has been seen before", () => {
    expect(introEnabled()).toBe(true);
    window.localStorage.setItem("ataraxia.introSeen", "1");
    expect(introEnabled()).toBe(true);
  });

  it("never plays for people who prefer reduced motion", () => {
    window.matchMedia = ((query: string) => ({ matches: true, media: query })) as typeof window.matchMedia;
    expect(introEnabled()).toBe(false);
  });
});

describe("Button", () => {
  it("gives quiet buttons the compact size and the others the regular one, without overrides", () => {
    const quiet = renderToStaticMarkup(<Button variant="quiet">x</Button>);
    const primary = renderToStaticMarkup(<Button variant="primary">x</Button>);
    expect(quiet).toContain("px-2.5");
    expect(primary).toContain("px-3.5");
    expect(quiet + primary).not.toContain("!");
  });

  it("has distinct hover, active and disabled states", () => {
    const html = renderToStaticMarkup(<Button>x</Button>);
    expect(html).toContain("hover:");
    expect(html).toContain("active:");
    expect(html).toContain("disabled:opacity-40");
  });
});

describe("words for states", () => {
  it("StatusLabel says the state, it does not leave it to a colour", () => {
    for (const [status, word] of [
      ["queued", "Waiting"],
      ["running", "Working"],
      ["ready", "Ready"],
      ["failed", "Failed"],
      ["stale", "Out of date"],
    ] as const) {
      expect(renderToStaticMarkup(<StatusLabel status={status} />)).toContain(word);
    }
  });

  it("a Chip is words in a box", () => {
    expect(renderToStaticMarkup(<Chip>Read-only</Chip>)).toContain("Read-only");
  });

  it("the loading and failed messages are announced", () => {
    expect(renderToStaticMarkup(<StateMessage text="Loading" tone="loading" />)).toContain('aria-live="polite"');
    expect(renderToStaticMarkup(<StateMessage text="Broke" tone="failed" />)).toContain('role="alert"');
  });

  it("a provider mark is the agent's own logo, decorative, and each agent has a different one", () => {
    const marks = (["claude", "codex", "opencode"] as const).map((provider) => renderToStaticMarkup(<ProviderMark provider={provider} />));
    for (const html of marks) {
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain("<svg");
    }
    expect(new Set(marks).size).toBe(3);
  });
});

describe("Toast", () => {
  it("wears the surface of the current theme, not the inverted colours of a tooltip, and names itself an alert", () => {
    const html = renderToStaticMarkup(<Toast message="could not switch" onDismiss={() => undefined} />);
    expect(html).toContain("bg-cg-float");
    expect(html).toContain("text-cg-ink");
    expect(html).not.toContain("cg-tip");
    expect(html).toContain('role="alert"');
    expect(renderToStaticMarkup(<Toast message={null} onDismiss={() => undefined} />)).toBe("");
  });
});

describe("BTW tells the main chat", () => {
  const task = (over: Record<string, unknown>) =>
    ({ status: "ready", updated_at: "2026-01-01T00:00:10Z", returned_at: null, ...over }) as never;

  it("says the main chat was told once the note went out after the last answer", () => {
    const html = renderToStaticMarkup(<MainChatNote task={task({ returned_at: "2026-01-01T00:00:10Z" })} />);
    expect(html).toContain("The main chat was told");
  });

  it("says the note is waiting when the main agent is busy, and says nothing while BTW still works", () => {
    expect(renderToStaticMarkup(<MainChatNote task={task({})} />)).toContain("It is told as soon as its turn ends");
    expect(renderToStaticMarkup(<MainChatNote task={task({ returned_at: "2026-01-01T00:00:05Z" })} />)).toContain("busy");
    expect(renderToStaticMarkup(<MainChatNote task={task({ status: "running" })} />)).toBe("");
  });
});

describe("rendering in the browser", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  function render(node: ReactNode) {
    act(() => root.render(node));
  }

  it("Tip leaves one button, linked to its label, with no wrapper that takes focus", () => {
    render(
      <Tip label="Settings">
        <button type="button">Open</button>
      </Tip>,
    );
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.querySelector('[role="button"]')).toBeNull();
    expect(host.querySelector("[tabindex]")).toBeNull();
    const button = host.querySelector("button")!;
    const tip = host.querySelector('[role="tooltip"]')!;
    expect(button.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.textContent).toBe("Settings");
  });

  it("ErrorBoundary shows what broke and lets the person try again", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let broken = true;
    function Fragile() {
      if (broken) {
        throw new Error("boom");
      }
      return <p>fine</p>;
    }
    render(
      <ErrorBoundary label="Code">
        <Fragile />
      </ErrorBoundary>,
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Code stopped working");
    expect(host.textContent).toContain("boom");
    broken = false;
    act(() => {
      host.querySelector("button")!.click();
    });
    expect(host.textContent).toContain("fine");
  });
});
