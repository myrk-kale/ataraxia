// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileLinksContext, readFileHref, type FileLinks } from "./fileLinks";
import { Markdown } from "./Markdown";

const links: FileLinks = {
  index: {
    files: new Set(["src/app/main.ts", "README.md", "api/src/server.rs"]),
    ownRoot: "/work/app",
    others: [{ name: "api", root: "/work/api" }],
  },
  open: () => undefined,
};

function html(text: string, value: FileLinks | null = links) {
  return renderToStaticMarkup(
    <FileLinksContext.Provider value={value}>
      <Markdown text={text} />
    </FileLinksContext.Provider>,
  );
}

describe("files named in a message", () => {
  it("become links in plain text, in code spans and in markdown links", () => {
    const out = html(
      "Look at src/app/main.ts:42-50 and `README.md`, or [the server](/work/api/src/server.rs#L7).",
    );
    expect(out.match(/role="link"/g)).toHaveLength(3);
    expect(out).toContain("Open src/app/main.ts:42-50 in the editor");
    expect(out).toContain("Open README.md in the editor");
    expect(out).toContain("Open api/src/server.rs:7 in the editor");
    // The code span keeps its look inside the link.
    expect(out).toMatch(/<code[^>]*>README\.md<\/code>/);
  });

  it("are left alone when no such file exists, and in fenced code", () => {
    const out = html("Not src/app/missing.ts here.\n\n```\nsrc/app/main.ts\n```");
    expect(out).not.toContain('role="link"');
  });

  it("stay plain text without a chat to read them against", () => {
    expect(html("See src/app/main.ts:3", null)).not.toContain('role="link"');
  });

  it("never turn a web link into a file link, nor render a script address", () => {
    const out = html("[docs](https://example.com/src/app/main.ts) and [x](javascript:alert(1))");
    expect(out).toContain('href="https://example.com/src/app/main.ts"');
    expect(out).not.toContain("javascript:");
  });

  it("reads back the address a file link carries", () => {
    expect(readFileHref("#ataraxia-file:" + encodeURIComponent(JSON.stringify({ path: "a.ts", line: 3, endLine: null })))).toEqual({
      path: "a.ts",
      line: 3,
      endLine: null,
    });
    expect(readFileHref("https://example.com")).toBeNull();
    expect(readFileHref("#ataraxia-file:%7Bbroken")).toBeNull();
  });
});
