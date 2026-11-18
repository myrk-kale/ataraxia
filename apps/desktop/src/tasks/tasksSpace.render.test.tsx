// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../lib/tasks";
import { TasksSpace } from "./TasksSpace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let store: Task[] = [];
const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "tasks_list":
        return Promise.resolve(store);
      case "task_create": {
        const made: Task = {
          number: Math.max(0, ...store.map((item) => item.number)) + 1,
          title: String(args?.title),
          notes: "",
          status: "draft",
          created_at: "t",
          updated_at: "t",
        };
        store = [made, ...store];
        return Promise.resolve(made);
      }
      case "task_update": {
        const patch = args?.patch as Partial<Task>;
        store = store.map((item) => (item.number === args?.number ? { ...item, ...patch } : item));
        return Promise.resolve(store.find((item) => item.number === args?.number));
      }
      case "task_delete":
        store = store.filter((item) => item.number !== args?.number);
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  },
}));

let host: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
  store = [];
  calls.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<TasksSpace active onError={() => undefined} />));
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the task list", () => {
  it("makes a task from a typed title with Enter, numbered, and shows it at once", async () => {
    const field = host.querySelector<HTMLInputElement>('input[aria-label="New task"]')!;
    await act(async () => type(field, "  fix the scroll "));
    await act(async () => {
      field.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(calls.find((call) => call.cmd === "task_create")?.args).toEqual({ title: "fix the scroll" });
    expect(host.textContent).toContain("#1");
    expect(host.textContent).toContain("fix the scroll");
    expect(field.value).toBe("");
  });

  it("marks a task ready for development from its card, and done with the checkbox", async () => {
    store = [{ number: 7, title: "ship it", notes: "", status: "draft", created_at: "t", updated_at: "t" }];
    // The list is read when the space first opens: open it again to see the seeded task.
    await act(async () => {
      root.unmount();
      root = createRoot(host);
      root.render(<TasksSpace active onError={() => undefined} />);
    });
    await flush();
    const card = host.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
    await act(async () => card.click());
    const ready = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Ready for development"))!;
    await act(async () => ready.click());
    await flush();
    expect(calls.find((call) => call.cmd === "task_update")?.args).toEqual({ number: 7, patch: { status: "ready" } });
    expect(host.textContent).toContain("Ready for development");

    const check = host.querySelector<HTMLButtonElement>('button[role="checkbox"]')!;
    await act(async () => check.click());
    await flush();
    expect(calls.filter((call) => call.cmd === "task_update").at(-1)?.args).toEqual({ number: 7, patch: { status: "done" } });
    // Done tasks leave the open view.
    expect(host.textContent).toContain("Everything is done.");
  });

  it("confirms deletion from a collapsed task without opening the card", async () => {
    store = [{ number: 3, title: "old idea", notes: "", status: "draft", created_at: "t", updated_at: "t" }];
    await act(async () => {
      root.unmount();
      root = createRoot(host);
      root.render(<TasksSpace active layout="drawer" onError={() => undefined} />);
    });
    await flush();
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="Delete #3"]')!;
    await act(async () => remove.click());
    expect(host.querySelector('input[aria-label="Title of #3"]')).toBeNull();
    expect(calls.some((call) => call.cmd === "task_delete")).toBe(false);
    const keep = [...host.querySelectorAll("button")].find((button) => button.textContent === "Keep")!;
    await act(async () => keep.click());
    expect(document.activeElement).toBe(remove);
    expect(calls.some((call) => call.cmd === "task_delete")).toBe(false);
    await act(async () => remove.click());
    const sure = [...host.querySelectorAll("button")].find((button) => button.textContent === "Delete for good")!;
    await act(async () => sure.click());
    await flush();
    expect(calls.find((call) => call.cmd === "task_delete")?.args).toEqual({ number: 3 });
    expect(host.textContent).not.toContain("old idea");
  });
});
