import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TranscriptRow } from "./TranscriptRow";

describe("reasoning", () => {
  it("renders the streamed content in a native disclosure", () => {
    const html = renderToStaticMarkup(<TranscriptRow sessionId="s" row={{ key: "r", after: 0, notice: false, item: { kind: "message", id: "r", role: "reasoning", text: "Consider this", turnId: "t" } }} />);
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("Consider this");
  });
});
