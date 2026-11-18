// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInsights } from "../dev/insightsMock";
import type { ChatSession } from "../lib/workspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
/** Answers a test wants to force, by command. */
let forced: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd in forced) {
      return Promise.resolve(forced[cmd]);
    }
    const result = handleInsights(cmd, args, () => undefined);
    return Promise.resolve(result.handled ? result.value : null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

const session = {
  id: "s1",
  repository_id: "r1",
  worktree_id: "w1",
  provider: "fake",
  title: "Chat",
  status: "ready",
} as unknown as ChatSession;

let root: Root;
let host: HTMLDivElement;

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  calls.length = 0;
  forced = {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("spaces render with real data shapes", () => {
  it("Decisions open full screen: one card per decision, open ones first, approve or reject with a comment", async () => {
    const { DecisionsReview } = await import("../decisions/DecisionsReview");
    const errors: string[] = [];
    act(() =>
      root.render(
        <DecisionsReview isOpen sessionId="s1" onClose={() => undefined} onError={(m) => errors.push(m)} onOpenFile={() => undefined} />,
      ),
    );
    await flush();
    const page = document.body.textContent ?? "";
    expect(page).toContain("2 decisions to review");
    expect(page).toContain("Write the retry helper locally");
    expect(page).toContain("Store only a hash of issued tokens?");
    // A decided one stays visible, after the open ones, with its verdict in words.
    expect(page).toContain("Return 202 Accepted");
    expect(page).toContain("Approved");
    // No threads any more: nothing to discuss, only a verdict.
    expect(page).not.toContain("Thread");
    expect(calls.some((c) => c.cmd === "decisions_generate")).toBe(false);

    const cards = () => [...document.body.querySelectorAll("li")].filter((li) => li.querySelector("h2"));
    const button = (card: Element, label: string) =>
      [...card.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
    const hash = () => cards().find((card) => card.textContent?.includes("Store only a hash"))!;

    // Reject asks why first, and cannot be sent empty.
    act(() => button(hash(), "Reject").click());
    const send = button(hash(), "Reject with this comment");
    expect(send.disabled).toBe(true);
    const field = hash().querySelector("textarea")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(field, "Use bcrypt instead");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button(hash(), "Reject with this comment").disabled).toBe(false);
    act(() => button(hash(), "Reject with this comment").click());
    await flush();
    expect(calls.find((c) => c.cmd === "decision_set_state")?.args).toMatchObject({
      decisionState: "rejected",
      comment: "Use bcrypt instead",
    });

    const retry = cards().find((card) => card.textContent?.includes("Write the retry helper locally"))!;
    act(() => button(retry, "Approve").click());
    await flush();
    expect(calls.filter((c) => c.cmd === "decision_set_state").at(-1)?.args).toMatchObject({ decisionState: "approved", comment: null });
    expect(document.body.textContent).toContain("All reviewed. The agent was sent what you rejected");
    expect(errors).toEqual([]);
  });

  it("the chat shows its decisions as a card that opens the review, and nothing when there are none", async () => {
    const { DecisionsCard } = await import("../decisions/DecisionsReview");
    let opened = 0;
    act(() => root.render(<DecisionsCard sessionId="s1" onOpen={() => (opened += 1)} />));
    await flush();
    expect(host.textContent).toContain("Decisions");
    expect(host.textContent).toMatch(/to review|Reviewed:/);
    act(() => (host.querySelector("button") as HTMLButtonElement).click());
    expect(opened).toBe(1);

    forced = { decisions_list: [], artifacts_list: [] };
    act(() => root.render(<DecisionsCard sessionId="s2" onOpen={() => undefined} />));
    await flush();
    expect(host.textContent).toBe("");
  });

  it("the shortcut legend and settings render their content", async () => {
    const { ShortcutLegend } = await import("./ShortcutLegend");
    act(() => root.render(<ShortcutLegend isOpen onClose={() => undefined} />));
    await flush();
    expect(document.body.textContent).toContain("Toggle the terminal");
    expect(document.body.textContent).toContain("BTW");
  });

  it("BTW says that the question is about the text that was selected, and where it is", async () => {
    const { BtwPalette } = await import("../btw/BtwPalette");
    const providers = [
      { kind: "fake", display_name: "Demo", available: true, detail: null, settings: { models: [{ id: "quick", label: "Quick", efforts: [] }] } },
    ] as never;
    act(() =>
      root.render(
        <BtwPalette
          isOpen
          item={{ kind: "selection", label: "tokens.py", path: "src/studio/auth/tokens.py", startLine: 6, endLine: 9, text: "a\nb\nc\nd" }}
          others={[]}
          providers={providers}
          resume={null}
          session={session}
          space="code"
          onClose={() => undefined}
          onError={(m) => { throw new Error(m); }}
        />,
      ),
    );
    await flush();
    const dialog = document.body.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("Selection · src/studio/auth/tokens.py:6-9 · 4 lines");
  });

  it("BTW is one wide bar: a placeholder and the choice of model joined to it, and nothing else", async () => {
    const { BtwPalette } = await import("../btw/BtwPalette");
    const providers = [
      { kind: "fake", display_name: "Demo", available: true, detail: null, settings: { models: [{ id: "quick", label: "Quick", efforts: [] }] } },
      { kind: "claude", display_name: "Claude Code", available: true, detail: null, settings: { models: [{ id: "sonnet", label: "Sonnet", efforts: [] }] } },
    ] as never;
    const render = () =>
      act(() =>
        root.render(
          <BtwPalette
            isOpen
            item={{ kind: "file", label: "tokens.py", path: "src/studio/auth/tokens.py", startLine: 6, endLine: 15 }}
            others={[]}
            providers={providers}
            resume={null}
            session={session}
            space="code"
            onClose={() => undefined}
            onError={(m) => { throw new Error(m); }}
          />,
        ),
      );
    render();
    await flush();
    const dialog = document.body.querySelector("[role=dialog]")!;
    const input = dialog.querySelector("input[aria-label='Ask about what you are looking at']") as HTMLInputElement;
    expect(input.placeholder).toBe("Ask or describe a change. BTW may edit files and run commands…");
    // Nothing is written in the bar except the placeholder and the model's name.
    const bar = dialog.cloneNode(true) as HTMLElement;
    bar.querySelectorAll("[popover]").forEach((list) => list.remove());
    const text = (bar.textContent ?? "").trim();
    expect(text).toBe("Demo · Default");
    for (const gone of ["BTW", "Enter", "Looking at", "inspect", "Delegate", "authorize", "read-only", "main chat"]) {
      expect(text, gone).not.toContain(gone);
    }
    expect(dialog.querySelectorAll("input[type=checkbox], [role=switch]")).toHaveLength(0);
    // The choice is one select, joined to the bar (it sits in the same form as the field).
    const select = dialog.querySelector("button[aria-label='Model that runs it']")!;
    expect(select.closest("form")).toBe(input.closest("form"));

    const setValue = (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    setValue("What does this do?");
    // The pencil makes this one question read-only.
    act(() => (dialog.querySelector("button[aria-label='Allow BTW to edit files']") as HTMLButtonElement).click());
    expect(input.placeholder).toBe("Ask about what you are looking at. Read-only…");
    // Enter in the field asks. (The model list has a search field of its own inside the same form,
    // which turns off the browser's Enter-to-submit, so the field handles Enter itself.)
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    const start = calls.find((c) => c.cmd === "btw_start")!;
    // It asks, never edits, and runs on the chosen model (the chat's own provider by default).
    expect(start.args).toMatchObject({ mode: "ask", authorized: false, returnPolicy: "on-completion", provider: "fake", model: null });
  });

  it("BTW may edit files and run commands by default, on the branch on screen", async () => {
    const { BtwPalette } = await import("../btw/BtwPalette");
    const providers = [
      { kind: "fake", display_name: "Demo", available: true, detail: null, settings: { models: [{ id: "quick", label: "Quick", efforts: [] }] } },
    ] as never;
    const task = { id: "t1", session_id: "h1", parent_session_id: "s1", mode: "change", status: "running" };
    const hidden = { ...session, id: "h1", kind: "delegate", title: "BTW: fix it", parent_session_id: "s1" };
    forced = {
      btw_start: task,
      btw_session: hidden,
      agent_get_snapshot: { items: [], subagents: [], restoredCount: 0, status: "ready", pendingPermission: null },
      schedule_list: [],
      agent_queue: { items: [], paused: false, reason: null },
    };
    act(() =>
      root.render(
        <BtwPalette
          isOpen
          item={null}
          others={[]}
          providers={providers}
          resume={null}
          session={session}
          space="chat"
          worktreeId="w2"
          onClose={() => undefined}
          onError={(m) => { throw new Error(m); }}
        />,
      ),
    );
    await flush();
    const dialog = document.body.querySelector("[role=dialog]")!;
    const pencil = dialog.querySelector("button[aria-label='Allow BTW to edit files']") as HTMLButtonElement;
    expect(pencil.getAttribute("aria-pressed")).toBe("true");
    const input = dialog.querySelector("input[aria-label='Ask about what you are looking at']") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "Rename the helper everywhere");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    const start = calls.find((c) => c.cmd === "btw_start")!;
    // Plain Enter may edit; the conversation opens to show what it does.
    expect(start.args).toMatchObject({ mode: "change", authorized: true, worktreeId: "w2", returnPolicy: "on-completion" });
    expect(calls.some((c) => c.cmd === "btw_session")).toBe(true);
    expect(document.body.querySelector("[role=dialog]")?.textContent).toContain("Can edit files");
  });

  it("a private BTW says so beside its accent border and never reaches the main chat", async () => {
    const { BtwPalette } = await import("../btw/BtwPalette");
    const providers = [
      { kind: "fake", display_name: "Demo", available: true, detail: null, settings: { models: [{ id: "quick", label: "Quick", efforts: [] }] } },
    ] as never;
    forced = { btw_start: { id: "t2", session_id: "h2", parent_session_id: "s1", mode: "ask", status: "running", return_policy: "manual" } };
    act(() =>
      root.render(
        <BtwPalette
          isOpen
          item={null}
          others={[]}
          private
          providers={providers}
          resume={null}
          session={session}
          space="code"
          onClose={() => undefined}
          onError={(m) => { throw new Error(m); }}
        />,
      ),
    );
    await flush();
    const dialog = document.body.querySelector("[role=dialog]")!;
    expect(dialog.getAttribute("aria-label")).toBe("Private BTW");
    expect(dialog.textContent).toContain("Private: not sent to the main chat");
    expect(dialog.className).toContain("border-cg-accent");
    act(() => (dialog.querySelector("button[aria-label='Allow BTW to edit files']") as HTMLButtonElement).click());
    const input = dialog.querySelector("input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "Just between us");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(calls.find((c) => c.cmd === "btw_start")?.args).toMatchObject({ returnPolicy: "manual" });
  });

  it("the review queue is a flat list of components, most critical first, with no file names and no reasons", async () => {
    const { ComponentQueue } = await import("../code/FileLists");
    const review = handleInsights("code_review", { checkpointId: null }, () => undefined).value as { priority: never };
    const opened: string[] = [];
    act(() =>
      root.render(
        <ComponentQueue
          activeUnit="u2"
          marks={new Map()}
          priority={review.priority}
          onOpenFile={() => undefined}
          onOpenUnit={(unit) => opened.push(unit.id)}
        />,
      ),
    );
    const text = host.textContent ?? "";
    const names = [...host.querySelectorAll("li button")].map((row) => row.querySelector("span span")?.textContent ?? "");
    // Components by name, not grouped by the file that holds them.
    expect(names).toContain("issue_token");
    expect(names).toContain("DocumentRepository.create");
    expect(names.indexOf("issue_token")).toBeLessThan(names.indexOf("README.md"));
    expect(text).not.toContain("tokens.py");
    expect(text).not.toContain("service.py");
    // Why a component ranks where it does is said when it is opened, not in the list.
    expect(text).not.toContain("touches a sensitive area");
    expect(text).toContain("High");
    expect(text).toContain("function · changed");
    expect(text).toContain("signature changed");
    const active = host.querySelector("[aria-selected='true']");
    expect(active?.textContent).toContain("verify");
    const row = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("dispatch"))!;
    act(() => (row as HTMLButtonElement).click());
    expect(opened).toEqual(["u3"]);
  });
});
