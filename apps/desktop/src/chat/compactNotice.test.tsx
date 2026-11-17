import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TranscriptRow } from "./TranscriptRow";

it("renders the persisted compaction notice as a divider", () => {
  const html = renderToStaticMarkup(<TranscriptRow sessionId="s" row={{ key: "n", after: 0, notice: false, item: { kind: "message", id: "n", role: "system", text: "Conversation compacted.", turnId: "t" } }} />);
  expect(html).toContain('role="note"');
  expect(html).toContain("Conversation compacted.");
  expect(html).toContain("bg-cg-line");
});
