import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ObjectBlock } from "./ObjectBlock";

const ID = "b".repeat(64);
const source = (fields: Record<string, unknown>) =>
  JSON.stringify({ url: `http://127.0.0.1:4000/f/${ID}/report.pdf`, ...fields });

describe("ObjectBlock", () => {
  it("shows a file a browser can draw in an object, with open and download", () => {
    const html = renderToStaticMarkup(<ObjectBlock source={source({ type: "application/pdf", title: "Report" })} />);
    expect(html).toContain("<object");
    expect(html).toContain(`data="http://127.0.0.1:4000/f/${ID}/report.pdf"`);
    expect(html).toContain('type="application/pdf"');
    expect(html).toContain(">Open<");
    expect(html).toContain(">Download<");
  });

  it("offers only the buttons for a file it cannot draw", () => {
    const html = renderToStaticMarkup(<ObjectBlock source={source({ type: "application/zip" })} />);
    expect(html).not.toContain("<object");
    expect(html).toContain("not shown in the chat");
    expect(html).toContain(">Download<");
  });
});
