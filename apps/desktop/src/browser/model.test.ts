import { describe, expect, it } from "vitest";
import type { ConsoleEntry, NetEntry, PageError } from "../lib/browser";
import {
  clock,
  consoleLines,
  displayAddress,
  failed,
  filterConsole,
  filterNet,
  formatBytes,
  formatDuration,
  hostOf,
  prettyBody,
  requestName,
  statusLabel,
  statusTone,
  tabLabel,
} from "./model";

function entry(over: Partial<NetEntry>): NetEntry {
  return {
    id: "n1",
    kind: "fetch",
    method: "GET",
    url: "https://app.test/api/items?page=2",
    page: "https://app.test/",
    t: 0,
    status: 200,
    done: true,
    reqHeaders: {},
    resHeaders: {},
    resTruncated: false,
    frames: [],
    seq: 1,
    ...over,
  };
}

describe("addresses and tabs", () => {
  it("shows an address without its scheme or trailing slash, and nothing for the blank page", () => {
    expect(displayAddress("https://example.com/")).toBe("example.com");
    expect(displayAddress("http://localhost:3000/app?x=1")).toBe("localhost:3000/app?x=1");
    expect(displayAddress("about:blank")).toBe("");
    expect(displayAddress("")).toBe("");
  });

  it("labels a tab by its title, else its address, else that it is new", () => {
    expect(tabLabel({ title: " Docs ", url: "https://a.test/" })).toBe("Docs");
    expect(tabLabel({ title: "", url: "https://a.test/x" })).toBe("a.test/x");
    expect(tabLabel({ title: "", url: "about:blank" })).toBe("New tab");
  });

  it("finds the host of an address", () => {
    expect(hostOf("https://a.test:8080/x")).toBe("a.test:8080");
    expect(hostOf("nonsense")).toBe("");
  });
});

describe("sizes and times", () => {
  it("formats bytes and durations for a list", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2150)).toBe("2.1 kB");
    expect(formatBytes(3 * 1048576)).toBe("3.0 MB");
    expect(formatDuration(40)).toBe("40 ms");
    expect(formatDuration(1500)).toBe("1.50 s");
    expect(formatDuration(undefined)).toBe("");
  });

  it("writes a time of day with two digits each", () => {
    expect(clock(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe("03:04:05");
  });
});

describe("requests", () => {
  it("tells what failed: an error, a 4xx or 5xx, or no answer at all, but not what is still going", () => {
    expect(failed(entry({ status: 404 }))).toBe(true);
    expect(failed(entry({ status: 500 }))).toBe(true);
    expect(failed(entry({ status: 0 }))).toBe(true);
    expect(failed(entry({ status: 0, done: false }))).toBe(false);
    expect(failed(entry({ error: "Failed to fetch", status: 0 }))).toBe(true);
    expect(failed(entry({ status: 200 }))).toBe(false);
    expect(failed(entry({ kind: "ws", status: 101 }))).toBe(false);
    expect(failed(entry({ kind: "resource", status: 0 }))).toBe(false);
    expect(failed(entry({ kind: "resource", status: 404 }))).toBe(true);
  });

  it("gives each a tone and a label for the status column", () => {
    expect(statusTone(entry({ status: 200 }))).toBe("ok");
    expect(statusTone(entry({ status: 302 }))).toBe("redirect");
    expect(statusTone(entry({ status: 404 }))).toBe("client");
    expect(statusTone(entry({ status: 503 }))).toBe("server");
    expect(statusTone(entry({ status: 0, done: false }))).toBe("pending");
    expect(statusTone(entry({ error: "x" }))).toBe("failed");
    expect(statusLabel(entry({ status: 201 }))).toBe("201");
    expect(statusLabel(entry({ done: false, status: 0 }))).toBe("…");
    expect(statusLabel(entry({ error: "x" }))).toBe("failed");
    expect(statusLabel(entry({ kind: "ws", status: 0 }))).toBe("ws");
  });

  it("names a request by its path, and by its host when it is another site's", () => {
    expect(requestName(entry({}))).toBe("/api/items?page=2");
    expect(requestName(entry({ url: "https://cdn.other.com/a.js" }))).toBe("cdn.other.com/a.js");
    expect(requestName(entry({ url: "not a url" }))).toBe("not a url");
  });

  it("filters by words in the address, status or type, and by what was asked for", () => {
    const list = [
      entry({ id: "a", url: "https://app.test/api/users", mime: "application/json" }),
      entry({ id: "b", url: "https://app.test/app.js", kind: "resource", mime: "script" }),
      entry({ id: "c", url: "https://app.test/api/orders", status: 500 }),
    ];
    const none = { text: "", apiOnly: false, onlyFailed: false };
    expect(filterNet(list, none)).toHaveLength(3);
    expect(filterNet(list, { ...none, apiOnly: true }).map((e) => e.id)).toEqual(["a", "c"]);
    expect(filterNet(list, { ...none, onlyFailed: true }).map((e) => e.id)).toEqual(["c"]);
    expect(filterNet(list, { ...none, text: "API  orders" }).map((e) => e.id)).toEqual(["c"]);
    expect(filterNet(list, { ...none, text: "json" }).map((e) => e.id)).toEqual(["a"]);
    expect(filterNet(list, { ...none, text: "500" }).map((e) => e.id)).toEqual(["c"]);
  });
});

describe("the console", () => {
  const logs: ConsoleEntry[] = [
    { seq: 1, level: "log", text: "booted", t: 1, page: "" },
    { seq: 3, level: "warn", text: "deprecated api", t: 3, page: "" },
    { seq: 4, level: "error", text: "login failed 401", t: 4, page: "" },
  ];
  const errors: PageError[] = [
    { seq: 2, kind: "exception", message: "TypeError: x is undefined", t: 2, page: "", source: "app.js", line: 10, column: 4, stack: "at render" },
    { seq: 5, kind: "resource", message: "Failed to load img", t: 5, page: "" },
  ];

  it("puts console lines and uncaught errors in one list, in the order they happened", () => {
    const lines = consoleLines(logs, errors);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(lines[1]).toMatchObject({ level: "error", uncaught: true, text: "TypeError: x is undefined (app.js:10:4)", detail: "at render" });
    expect(lines[4].text).toBe("Failed to load img");
    expect(lines[0].uncaught).toBe(false);
    expect(consoleLines([{ seq: 1, level: "trace", text: "t", t: 0, page: "" }], [])[0].level).toBe("log");
  });

  it("filters by level and by words", () => {
    const lines = consoleLines(logs, errors);
    expect(filterConsole(lines, "all", "").length).toBe(5);
    expect(filterConsole(lines, "error", "").map((l) => l.seq)).toEqual([2, 4, 5]);
    expect(filterConsole(lines, "warn", "").map((l) => l.seq)).toEqual([3]);
    expect(filterConsole(lines, "all", "LOGIN").map((l) => l.seq)).toEqual([4]);
    expect(filterConsole(lines, "log", "").map((l) => l.seq)).toEqual([1]);
  });
});

describe("bodies", () => {
  it("indents JSON and leaves other text alone", () => {
    expect(prettyBody('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
    expect(prettyBody("<html>")).toBe("<html>");
    expect(prettyBody(null)).toBe("");
  });
});
