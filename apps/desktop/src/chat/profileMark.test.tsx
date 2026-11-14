import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProfileMarkView } from "./ProfileMark";
import { ProviderMark } from "./ProviderMark";

const WORK = { name: "Work", color: "#3b82f6" };

describe("ProfileMarkView", () => {
  it("is the plain mark with no profile: the default way of starting has no sign", () => {
    expect(renderToStaticMarkup(<ProfileMarkView profile={null} provider="claude" />)).toBe(
      renderToStaticMarkup(<ProviderMark provider="claude" size={24} />),
    );
  });

  it("puts a blur of the profile's colour behind the mark", () => {
    const html = renderToStaticMarkup(<ProfileMarkView profile={WORK} provider="claude" size={24} />);
    expect(html).toContain('data-profile-glow="#3b82f6"');
    expect(html).toContain("background:#3b82f6");
    expect(html).toContain("filter:blur(");
    // The glow is decoration, and the mark is still drawn over it.
    expect(html).toMatch(/aria-hidden="true"[^>]*data-profile-glow/);
    expect(html).toContain("<svg");
  });

  it("names the profile for a screen reader, whatever the colour", () => {
    const html = renderToStaticMarkup(<ProfileMarkView profile={WORK} provider="codex" />);
    expect(html).toContain("Profile: Work");
  });

  it("carries the name for the hover tooltip", () => {
    const html = renderToStaticMarkup(<ProfileMarkView profile={WORK} provider="opencode" />);
    expect(html).toContain('role="tooltip"');
    expect(html).toContain(">Work<");
  });

  it("scales the glow with the mark", () => {
    const small = renderToStaticMarkup(<ProfileMarkView profile={WORK} provider="claude" size={16} />);
    const large = renderToStaticMarkup(<ProfileMarkView profile={WORK} provider="claude" size={48} />);
    const blur = (html: string) => Number(/blur\((\d+)px\)/.exec(html)?.[1]);
    expect(blur(large)).toBeGreaterThan(blur(small));
  });
});
