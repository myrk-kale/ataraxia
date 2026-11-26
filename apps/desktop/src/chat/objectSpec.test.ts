import { describe, expect, it } from "vitest";
import { parseObjectBlock } from "./objectSpec";

const ID = "a".repeat(64);
const url = `http://127.0.0.1:51234/f/${ID}/Q3%20report.pdf`;
const block = (fields: Record<string, unknown>) => JSON.stringify({ url, ...fields });

describe("parseObjectBlock", () => {
  it("reads a file of the local file server and derives the download address", () => {
    const parsed = parseObjectBlock(block({ title: "Q3 report.pdf", type: "application/pdf" }));
    expect(parsed).toEqual({
      ok: true,
      spec: {
        url,
        downloadUrl: `${url}?download=1`,
        title: "Q3 report.pdf",
        type: "application/pdf",
        height: 480,
        inline: true,
      },
    });
  });

  it("takes the title from the name in the address, and clamps the height", () => {
    const tall = parseObjectBlock(block({ height: 5000 }));
    const short = parseObjectBlock(block({ height: 10 }));
    expect(tall.ok && tall.spec.title).toBe("Q3 report.pdf");
    expect(tall.ok && tall.spec.height).toBe(900);
    expect(short.ok && short.spec.height).toBe(200);
  });

  it("offers only a download for what a browser cannot draw", () => {
    const parsed = parseObjectBlock(block({ type: "application/zip" }));
    expect(parsed.ok && parsed.spec.inline).toBe(false);
    const unknown = parseObjectBlock(block({ type: "not a type" }));
    expect(unknown.ok && unknown.spec.type).toBe("application/octet-stream");
  });

  it("refuses anything that is not the app's own file server", () => {
    for (const bad of [
      "https://example.com/f/" + ID + "/a.pdf",
      `http://evil.example:80/f/${ID}/a.pdf`,
      `http://127.0.0.1/f/${ID}/a.pdf`,
      `http://user:pw@127.0.0.1:5/f/${ID}/a.pdf`,
      `http://127.0.0.1:5/other/${ID}/a.pdf`,
      `http://127.0.0.1:5/f/short/a.pdf`,
      `http://127.0.0.1:5/f/${ID}/a/b.pdf`,
      "javascript:alert(1)",
      "not an address",
    ]) {
      expect(parseObjectBlock(JSON.stringify({ url: bad })).ok, bad).toBe(false);
    }
  });

  it("refuses what is not a JSON object with a url", () => {
    for (const bad of ["", "{", "[]", "null", "{}", '{"url": 3}']) {
      expect(parseObjectBlock(bad).ok, bad).toBe(false);
    }
  });
});
