// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession, Worktree } from "../lib/workspace";
import { newBridge } from "../app/spaceCommands";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
let answers: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {};
const listeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    const answer = answers[cmd];
    if (!answer) {
      return Promise.resolve(null);
    }
    try {
      return Promise.resolve(answer(args));
    } catch (error) {
      return Promise.reject(error);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => listeners.delete(name));
  },
}));
// Monaco does not run in jsdom: a plain text area stands in, with the same props that matter.
vi.mock("./MonacoEditor", () => ({
  MonacoEditor: ({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (text: string) => void }) => (
    <textarea aria-label="Editor" data-readonly={String(readOnly)} readOnly={readOnly} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const session = { id: "s1", repository_id: "r1", worktree_id: "w1", provider: "fake", title: "Chat", status: "ready" } as unknown as ChatSession;
const worktree = (branch: string | null) => ({ id: "w1", repository_id: "r1", path: "/repo", branch, head: "abc" }) as unknown as Worktree;

const emptyReview = { checkpoints: [], checkpoint: null, priority: null, marks: [], comments: [], artifacts: [] };
const checkpoint = (id: string, source: string, paths: string[]) => ({
  id,
  session_id: "s1",
  worktree_id: "w1",
  seq: 1,
  base_rev: "b",
  head_rev: "h",
  source,
  turn_id: null,
  files: paths.map((path) => ({ path, old_path: null, change: "modified", additions: 1, deletions: 0, binary: false })),
  status: "ready",
  created_at: "2026-01-01T00:00:00Z",
  base_label: source === "compare" ? "develop (merge base)" : null,
  head_label: source === "compare" ? "working tree" : null,
  head_live: true,
});
const reviewOf = (cp: ReturnType<typeof checkpoint>) => ({
  checkpoints: [cp],
  checkpoint: cp,
  priority: {
    components: [],
    files: cp.files.map((file) => ({ path: file.path, score: 10, level: "low", reasons: ["small"], additions: 1, deletions: 0, change: "modified" })),
    units: [],
    languages: [],
  },
  marks: [],
  comments: [],
  artifacts: [],
});

let root: Root;
let host: HTMLDivElement;

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(node: ReactNode) {
  act(() => root.render(node));
  await flush();
}

async function space(props: { reference?: string | null; branch?: string | null; mode?: "changed" | "tree" }) {
  window.localStorage.setItem("ataraxia.codeMode", props.mode ?? "changed");
  const { CodeSpace } = await import("./CodeSpace");
  await render(
    <CodeSpace
      bridge={{ current: newBridge() }}
      reference={props.reference ?? null}
      session={session}
      worktree={worktree(props.branch === undefined ? "feature/x" : props.branch)}
      onBtw={() => undefined}
      onError={(message) => {
        throw new Error(message);
      }}
    />,
  );
}

const count = (cmd: string) => calls.filter((call) => call.cmd === cmd).length;

beforeEach(() => {
  calls.length = 0;
  answers = {};
  listeners.clear();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom has no layout: an attached element counts as shown.
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
});

describe("what the Code space compares", () => {
  it("shows no diff and says why when no comparison is chosen, and never asks for one", async () => {
    answers.code_review = () => emptyReview;
    answers.code_tree = () => [];
    await space({ reference: null, branch: "feature/x" });
    const text = host.textContent ?? "";
    expect(text).toContain("No comparison chosen");
    expect(text).toContain("Pick a branch or a commit in Compare with…");
    expect(count("code_compare")).toBe(0);
    expect(host.querySelectorAll("[data-testid=shown-label]")[0]?.textContent).toContain("No comparison chosen");
  });

  it("says the worktree is not on a branch when there is none, and still compares nothing", async () => {
    answers.code_review = () => emptyReview;
    answers.code_tree = () => [];
    await space({ reference: null, branch: null });
    const text = host.textContent ?? "";
    expect(text).toContain("not on a branch");
    expect(text).toContain("Switch to a branch in the header");
    expect(count("code_compare")).toBe(0);
  });

  it("compares the branch with the reference once one is chosen, and names both", async () => {
    answers.code_compare = () => checkpoint("c1", "compare", ["a.ts"]);
    answers.code_review = () => reviewOf(checkpoint("c1", "compare", ["a.ts"]));
    answers.code_tree = () => ["a.ts"];
    await space({ reference: "develop", branch: "feature/x" });
    expect(count("code_compare")).toBe(1);
    expect(calls.find((call) => call.cmd === "code_compare")?.args).toMatchObject({ base: "develop", head: null });
    expect(host.querySelector("[data-testid=shown-label]")?.textContent).toContain("feature/x against develop");
  });

  it("explains a reference that cannot be compared instead of showing an old diff", async () => {
    answers.code_compare = () => {
      throw new Error("error[invalid]: there are no differences between develop and working tree");
    };
    answers.code_tree = () => [];
    await space({ reference: "develop", branch: "feature/x" });
    expect(host.textContent).toContain("Nothing to show against develop: there are no differences between develop and working tree");
  });
});

describe("the label above the Changed list", () => {
  it("is cut with an ellipsis, keeps the full text in a title and for screen readers, and leaves the refresh button in place", async () => {
    const branch = "feat/feedbacks-integration-develop-scope-with-a-very-long-name-indeed";
    const reference = "origin/release/2026.11-hotfix-for-the-integration-of-feedbacks-scope";
    answers.code_compare = () => checkpoint("c1", "compare", ["a.ts"]);
    answers.code_review = () => reviewOf(checkpoint("c1", "compare", ["a.ts"]));
    answers.code_tree = () => ["a.ts"];
    await space({ reference, branch });

    const label = host.querySelector("[data-testid=shown-label]") as HTMLElement;
    const full = `${branch} against ${reference}`;
    expect(label.className).toContain("truncate");
    expect(label.className).toContain("min-w-0");
    expect(label.className).toContain("flex-1");
    expect(label.title).toContain(full);
    // Truncation is only visual: the whole text and its purpose are in the accessible name.
    expect(label.textContent).toBe(`Showing: ${full}`);
    // The button cannot be squeezed out, and neither can the wrapper that holds its tooltip.
    const button = host.querySelector("button[aria-label='Refresh checkpoint']") as HTMLElement;
    expect(button.className).toContain("flex-none");
    expect(button.parentElement?.className).toContain("flex-none");
    // The row can shrink below its content, so it cannot push past the panel.
    expect(label.parentElement?.className).toContain("min-w-0");
  });
});

describe("the views follow the files", () => {
  const emit = (worktreeId = "w1") => listeners.get("worktree://files-changed")?.({ payload: { worktreeId } });
  const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

  it("reads the project files again after a burst of changes, once, and only for its own worktree", async () => {
    let files = ["a.ts", "b.ts"];
    answers.code_tree = () => files;
    answers.code_review = () => emptyReview;
    await space({ mode: "tree" });
    expect(host.textContent).toContain("b.ts");
    expect(count("code_tree")).toBe(1);

    files = ["a.ts"];
    act(() => {
      emit("w2");
      emit();
      emit();
      emit();
    });
    await wait(800);
    await flush();
    expect(count("code_tree")).toBe(2);
    expect(host.textContent).toContain("a.ts");
    expect(host.textContent).not.toContain("b.ts");
  });

  it("changes nothing on screen when what it reads is the same", async () => {
    answers.code_tree = () => ["a.ts", "b.ts"];
    answers.code_review = () => emptyReview;
    await space({ mode: "tree" });
    // The tabs animate on their own; what must not move is the list and the file pane.
    const shown = () => `${host.querySelector("[role=tree]")?.outerHTML}${host.querySelector("section")?.outerHTML}`;
    const before = shown();
    const list = host.querySelector("[role=tree]");
    act(() => emit());
    await wait(800);
    await flush();
    expect(count("code_tree")).toBe(2);
    expect(shown()).toBe(before);
    expect(host.querySelector("[role=tree]")).toBe(list);
    expect(host.querySelector("[role=status], [role=alert]")).toBeNull();
  });

  it("compares again when the files change and a reference is chosen, and updates the list", async () => {
    let paths = ["a.ts"];
    answers.code_compare = () => checkpoint(`c-${paths.join("-")}`, "compare", paths);
    answers.code_review = (args) => reviewOf(checkpoint(String(args?.checkpointId), "compare", paths));
    answers.code_tree = () => paths;
    await space({ reference: "develop", branch: "feature/x" });
    expect(host.textContent).toContain("a.ts");
    expect(count("code_compare")).toBe(1);

    paths = ["a.ts", "added-in-terminal.ts"];
    act(() => emit());
    await wait(800);
    await flush();
    expect(count("code_compare")).toBe(2);
    expect(host.textContent).toContain("added-in-terminal.ts");
  });

  it("does not run while the window is hidden, and runs once when it is shown again", async () => {
    answers.code_tree = () => ["a.ts"];
    answers.code_review = () => emptyReview;
    await space({ mode: "tree" });
    let hidden = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    act(() => {
      emit();
      emit();
    });
    await wait(800);
    expect(count("code_tree")).toBe(1);
    hidden = false;
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await wait(50);
    await flush();
    expect(count("code_tree")).toBe(2);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });
});

describe("an open file that disappears", () => {
  const emit = () => listeners.get("worktree://files-changed")?.({ payload: { worktreeId: "w1" } });
  const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
  const file = (text: string) => ({ path: "a.ts", text, binary: false, tooLarge: false, size: text.length, mtimeMs: 10 });

  async function open() {
    let present = true;
    answers.code_tree = () => ["a.ts"];
    answers.code_review = () => emptyReview;
    answers.code_read = () => {
      if (!present) {
        throw new Error("error[not-found]: a.ts does not exist");
      }
      return file("hello\n");
    };
    await space({ mode: "tree" });
    const row = [...host.querySelectorAll("button, [role=treeitem], [role=option]")].find((item) => item.textContent?.includes("a.ts")) as HTMLElement;
    act(() => row.click());
    await flush();
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello\n");
    return {
      remove: async () => {
        present = false;
        act(() => emit());
        await wait(800);
        await flush();
      },
    };
  }

  it("shows the file as removed, read-only, with its last text, and does not crash", async () => {
    const opened = await open();
    await opened.remove();
    const banner = host.querySelector("[data-testid=removed-banner]");
    expect(banner?.textContent).toContain("This file was removed from disk");
    expect(banner?.textContent).toContain("read-only");
    expect(host.textContent).toContain("a.ts (removed)");
    const editor = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(editor.value).toBe("hello\n");
    expect(editor.dataset.readonly).toBe("true");
  });

  it("keeps unsaved edits, still editable, and writes them back on request", async () => {
    answers.code_write = () => 20;
    const opened = await open();
    const editor = () => host.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(editor(), "hello\nmy unsaved line\n");
      editor().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await opened.remove();
    const banner = host.querySelector("[data-testid=removed-banner]");
    expect(banner?.textContent).toContain("Your unsaved edits are still here");
    expect(editor().value).toBe("hello\nmy unsaved line\n");
    expect(editor().dataset.readonly).toBe("false");
    expect([...banner!.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Write it again"]);

    act(() => (banner!.querySelector("button") as HTMLButtonElement).click());
    await flush();
    const write = calls.find((call) => call.cmd === "code_write");
    expect(write?.args).toMatchObject({ path: "a.ts", text: "hello\nmy unsaved line\n", expectedMtimeMs: null });
    expect(host.querySelector("[data-testid=removed-banner]")).toBeNull();
  });
});
