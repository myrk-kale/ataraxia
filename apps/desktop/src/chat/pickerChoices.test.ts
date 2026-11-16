import { describe, expect, it } from "vitest";
import type { MentionPath, SlashCommand } from "../lib/agent";
import {
  applyChoice,
  commandItems,
  expandGlobMentions,
  findTrigger,
  mentionItems,
  mentionText,
  score,
} from "./pickerChoices";

const command = (name: string, description = "", extra: Partial<SlashCommand> = {}) => ({
  name,
  description,
  hint: null,
  source: null,
  ...extra,
});

const file = (path: string, extra: Partial<MentionPath> = {}): MentionPath => ({
  path,
  dir: false,
  repository: null,
  ...extra,
});

describe("findTrigger", () => {
  it("sees a command only at the very start of the message", () => {
    expect(findTrigger("/rev", 4, true)).toEqual({ kind: "command", query: "rev", start: 0, end: 4 });
    expect(findTrigger("/", 1, true)?.query).toBe("");
    expect(findTrigger("hello /rev", 10, true)).toBeNull();
    expect(findTrigger("/review main", 12, true)).toBeNull();
    expect(findTrigger("/rev", 4, false)).toBeNull();
  });

  it("follows the caret, not the end of the text", () => {
    expect(findTrigger("/review", 3, true)?.query).toBe("re");
    expect(findTrigger("/review", 3, true)?.end).toBe(3);
  });

  it("sees a mention after a space or at the start, anywhere in the message", () => {
    expect(findTrigger("look at @src/ma", 15, true)).toEqual({
      kind: "mention",
      query: "src/ma",
      start: 8,
      end: 15,
    });
    expect(findTrigger("@read", 5, true)?.kind).toBe("mention");
    expect(findTrigger("line one\n@foo", 13, true)?.start).toBe(9);
  });

  it("does not take an at sign inside a word for a mention", () => {
    expect(findTrigger("mail me@example", 15, true)).toBeNull();
    expect(findTrigger("hello", 5, true)).toBeNull();
  });

  it("leaves the opening quote of a quoted path out of the search", () => {
    expect(findTrigger('@"my', 4, true)?.query).toBe("my");
  });

  it("works for a mention inside a subagent chat where commands are off", () => {
    expect(findTrigger("@foo", 4, false)?.kind).toBe("mention");
  });
});

describe("score", () => {
  it("prefers a start, then a word start, then a part, then letters in order", () => {
    const start = score("compact", "com") ?? -1;
    const word = score("code-review", "rev") ?? -1;
    const part = score("recompact", "com") ?? -1;
    const letters = score("compact", "cmp") ?? -1;
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(part);
    expect(part).toBeGreaterThan(letters);
    expect(letters).toBeGreaterThan(0);
  });

  it("matches nothing when the letters are not all there in order", () => {
    expect(score("compact", "xyz")).toBeNull();
    expect(score("compact", "tpm")).toBeNull();
  });

  it("is case insensitive and takes anything for an empty query", () => {
    expect(score("README.md", "readme")).not.toBeNull();
    expect(score("anything", "")).toBe(0);
  });

  it("does not take the query for a pattern", () => {
    expect(score("a.b", ".*")).toBeNull();
    expect(score("a(b", "(")).not.toBeNull();
  });
});

describe("commandItems", () => {
  const list = [
    command("review", "Review the changes", { hint: "[branch]" }),
    command("compact", "Compact it", { source: "user" }),
    command("code-review", "Review code"),
  ];

  it("lists everything, in the agent's order, for an empty query", () => {
    expect(commandItems(list, "").map((item) => item.label)).toEqual([
      "/review",
      "/compact",
      "/code-review",
    ]);
  });

  it("ranks a name that starts with the query before one that only contains it", () => {
    expect(commandItems(list, "rev").map((item) => item.label)).toEqual([
      "/review",
      "/code-review",
    ]);
  });

  it("puts the hint, or else the source, on the right and a space after the name", () => {
    const items = commandItems(list, "");
    expect(items[0].aside).toBe("[branch]");
    expect(items[1].aside).toBe("user");
    expect(items[0].insert).toBe("/review ");
  });
});

describe("mentionItems", () => {
  it("filters file paths using glob wildcards", () => {
    const paths = [
      { path: "src/main.ts", dir: false, repository: null },
      { path: "src/deep/test.ts", dir: false, repository: null },
      { path: "src/main.rs", dir: false, repository: null },
    ];
    expect(mentionItems(paths, "src/**/*.ts").map((item) => item.label)).toEqual([
      "src/main.ts", "src/deep/test.ts",
    ]);
    expect(mentionItems(paths, "src/*.ts").map((item) => item.label)).toEqual(["src/main.ts"]);
  });
  const paths = [
    file("src/", { dir: true }),
    file("src/main.rs"),
    file("src/app/main_window.rs"),
    file("README.md"),
    file("/work/other/lib.rs", { repository: "other" }),
  ];

  it("finds a file by its name before its folder", () => {
    const items = mentionItems(paths, "main");
    expect(items.map((item) => item.label)).toEqual(["src/main.rs", "src/app/main_window.rs"]);
  });

  it("offers only file references", () => {
    const items = mentionItems(paths, "src");
    expect(items.every((item) => item.kind === "file")).toBe(true);
    const found = items.find((item) => item.label === "src/main.rs");
    expect(found?.insert).toBe("@src/main.rs ");
    expect(found?.continues).toBe(false);
  });

  it("narrows to what is inside a folder once its path is typed", () => {
    const items = mentionItems(paths, "src/app/");
    expect(items.map((item) => item.label)).toEqual(["src/app/main_window.rs"]);
  });

  it("names the repository of a path that is in another one", () => {
    const [item] = mentionItems(paths, "lib");
    expect(item.label).toBe("lib.rs");
    expect(item.aside).toBe("other");
    expect(item.insert).toBe("@/work/other/lib.rs ");
  });

  it("does not offer agents", () => {
    const items = mentionItems(paths, "re");
    expect(items.some((item) => item.label === "README.md")).toBe(true);
  });

  it("quotes a path that has a space in it", () => {
    expect(mentionText("my docs/a.md")).toBe('@"my docs/a.md"');
    expect(mentionText("a.md")).toBe("@a.md");
  });

  it("never lists more than a screen of choices", () => {
    const many = Array.from({ length: 500 }, (_, i) => file(`dir/file${i}.ts`));
    expect(mentionItems(many, "file").length).toBeLessThanOrEqual(40);
  });
});

describe("applyChoice", () => {
  it("replaces what was typed and puts the caret after the choice", () => {
    const trigger = findTrigger("look at @src/ma now", 15, true);
    if (!trigger) {
      throw new Error("no trigger");
    }
    const done = applyChoice("look at @src/ma now", trigger, "@src/main.rs ");
    expect(done.text).toBe("look at @src/main.rs now");
    expect(done.caret).toBe(21);
  });

  it("completes a command at the start", () => {
    const trigger = findTrigger("/rev", 4, true);
    if (!trigger) {
      throw new Error("no trigger");
    }
    expect(applyChoice("/rev", trigger, "/review ")).toEqual({ text: "/review ", caret: 8 });
  });
});

describe("expandGlobMentions", () => {
  it("expands file globs only when @ starts a mention token", () => {
    const paths = [file("src/a.ts"), file("src/b.ts")];
    expect(expandGlobMentions("Use @src/*.ts", paths)).toBe("Use @src/a.ts @src/b.ts");
    expect(expandGlobMentions("mail me@src/*.ts", paths)).toBe("mail me@src/*.ts");
  });

  it("keeps trailing prose punctuation after a matching glob", () => {
    const paths = [file("src/a.ts"), file("src/b.ts")];
    expect(expandGlobMentions("Use @src/*.ts, then @src/*.tsx.", paths)).toBe(
      "Use @src/a.ts @src/b.ts, then @src/*.tsx.",
    );
  });
});
