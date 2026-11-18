// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../lib/search";
import { GlobalSearch } from "./GlobalSearch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const result = (id: number, title: string, kind: SearchResult["kind"] = "chat"): SearchResult => ({
  documentId: id,
  kind,
  itemId: String(id),
  sessionId: null,
  btwId: null,
  title,
  excerpt: `about ${title.toLowerCase()} and more`,
  workspace: "Ataraxia",
  repository: "ataraxia",
  repositoryId: null,
  path: null,
  line: null,
  checkpointId: null,
  worktreeId: null,
});

const requests: unknown[] = [];
let answer: SearchResult[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => {
    if (cmd === "global_search") {
      requests.push(args);
      return Promise.resolve(answer);
    }
    return Promise.resolve(null);
  },
}));

let host: HTMLDivElement;
let root: Root;
const opened: SearchResult[] = [];
const onClose = vi.fn();

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  }
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(input: HTMLInputElement, name: string) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
}

const field = () => document.body.querySelector<HTMLInputElement>("input[aria-label='Search Ataraxia']")!;
const options = () => [...document.body.querySelectorAll<HTMLElement>("[aria-label='Search results'] [role=option]")];

beforeEach(() => {
  requests.length = 0;
  opened.length = 0;
  onClose.mockReset();
  answer = [result(1, "Fix the login flow"), result(2, "Login redesign", "task"), result(3, "Unrelated login note", "decision")];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <GlobalSearch
        repositories={[]}
        workspaces={[]}
        onClose={onClose}
        onOpen={(item) => {
          opened.push(item);
          return Promise.resolve();
        }}
      />,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the search palette", () => {
  it("filters with chips, not native selects", () => {
    expect(document.body.querySelector("select")).toBeNull();
    for (const name of ["Type", "Workspace", "Repository"]) {
      expect(document.body.querySelector(`button[aria-label='${name}']`)).not.toBeNull();
    }
    expect(document.body.textContent).toContain("Find anything you have done here.");
  });

  it("lists matches with the words picked out, and the arrows move a highlight while focus stays in the field", async () => {
    type(field(), "login");
    await flush();
    expect(requests).toHaveLength(1);
    expect(options().map((item) => item.querySelector("span.truncate")?.textContent)).toEqual([
      "Fix the login flow",
      "Login redesign",
      "Unrelated login note",
    ]);
    expect(document.body.querySelectorAll("mark").length).toBeGreaterThan(2);
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    key(field(), "ArrowDown");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(field().getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
    expect(document.activeElement).toBe(field());
    // Up from the first row wraps to the last.
    key(field(), "ArrowUp");
    key(field(), "ArrowUp");
    expect(options()[2]?.getAttribute("aria-selected")).toBe("true");
  });

  it("opens the highlighted result with Enter and closes", async () => {
    type(field(), "login");
    await flush();
    key(field(), "ArrowDown");
    key(field(), "Enter");
    await flush();
    expect(opened.map((item) => item.documentId)).toEqual([2]);
    expect(onClose).toHaveBeenCalled();
  });

  it("opens a result that is clicked", async () => {
    type(field(), "login");
    await flush();
    await act(async () => options()[2]?.click());
    await flush();
    expect(opened.map((item) => item.documentId)).toEqual([3]);
  });

  it("says what it did not find, quoting the search", async () => {
    answer = [];
    type(field(), "zzz");
    await flush();
    expect(document.body.textContent).toContain("No matches for “zzz”");
    expect(options()).toHaveLength(0);
  });
});
