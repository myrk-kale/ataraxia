import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Wordmark, WORDMARK } from "./Wordmark";

describe("Wordmark", () => {
  it("spells the name as written, in Ultra Light with about 0.28em of tracking", () => {
    expect(WORDMARK.text).toBe("Ataraxia");
    expect(WORDMARK.fontWeight).toBe(200);
    expect(WORDMARK.letterSpacing).toBe("0.28em");
    const html = renderToStaticMarkup(<Wordmark />);
    expect(html).toContain(">Ataraxia<");
    expect(html).toContain("Avenir Next");
    expect(html).toContain("font-weight:200");
    expect(html).toContain("letter-spacing:0.28em");
  });
});
