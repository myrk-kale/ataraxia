// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Memory, MemoryLink } from "../lib/memory";
import { MemoryPanel } from "./MemoryPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const made = (id: string, title: string, body: string, over: Partial<Memory> = {}): Memory => ({
  id,
  kind: "semantic",
  workspaceId: null,
  title,
  body,
  tags: [],
  source: "observed",
  author: "agent",
  expiresAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

let memories: Memory[] = [];
let links: MemoryLink[] = [];
let enabled = true;
const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "memory_snapshot":
        return Promise.resolve({ enabled, memories, links });
      case "memory_set_enabled":
        enabled = Boolean(args?.enabled);
        return Promise.resolve(null);
      case "memory_update": {
        const change = args?.change as Partial<Memory>;
        memories = memories.map((item) => (item.id === args?.id ? { ...item, ...change, updatedAt: "2026-02-02T00:00:00Z" } : item));
        return Promise.resolve(memories.find((item) => item.id === args?.id));
      }
      case "memory_delete":
        memories = memories.filter((item) => item.id !== args?.id);
        links = links.filter((link) => link.fromId !== args?.id && link.toId !== args?.id);
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
    await Promise.resolve();
  });
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

const button = (text: string) => [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === text) as HTMLButtonElement;
const rows = () => [...host.querySelectorAll("ul > li")];

beforeEach(async () => {
  memories = [
    made("a", "Answers in Portuguese", "The developer wants Portuguese."),
    made("b", "Tokens use SHA-256", "Random tokens need no slow hash.", { workspaceId: "ws1" as Memory["workspaceId"], kind: "episodic" }),
    made("c", "Old build note", "Gone by now.", { kind: "working", expiresAt: "2020-01-01T00:00:00Z" }),
  ];
  links = [{ fromId: "a", toId: "b", relation: "relates_to", createdAt: "2026-01-01T00:00:00Z" }];
  enabled = true;
  calls.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryPanel currentWorkspaceId={"ws1"} workspaces={[{ id: "ws1" as never, name: "backend" }]} onOpenGraph={() => undefined} />,
    ),
  );
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("MemoryPanel", () => {
  it("lists what is remembered with its kind and scope, and marks what has expired", () => {
    expect(rows()).toHaveLength(3);
    const text = host.textContent ?? "";
    expect(text).toContain("Answers in Portuguese");
    expect(rows()[1]!.textContent).toContain("backend");
    expect(rows()[1]!.textContent).toContain("Episodic");
    expect(rows()[0]!.textContent).toContain("Global");
    expect(rows()[2]!.textContent).toContain("Expired");
  });

  it("narrows the list as you type, over the title, the body and the tags", async () => {
    const search = host.querySelector('input[aria-label="Search memories"]') as HTMLInputElement;
    await act(async () => type(search, "slow hash"));
    expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining("Tokens use SHA-256")]);
    await act(async () => type(search, "nothing like this"));
    expect(host.textContent).toContain("No memory matches.");
  });

  it("switches memory off and on", async () => {
    const toggle = host.querySelector('input[type="checkbox"], [role="switch"]') as HTMLElement;
    await act(async () => toggle.click());
    await flush();
    expect(calls.some((call) => call.cmd === "memory_set_enabled" && call.args?.enabled === false)).toBe(true);
  });

  it("opens a memory, saves an edit, and shows what it is linked to", async () => {
    await act(async () => rows()[0]!.querySelector("button")!.click());
    expect(host.textContent).toContain("relates to");
    expect(host.textContent).toContain("Tokens use SHA-256");
    const title = host.querySelector('input[maxlength="120"]') as HTMLInputElement;
    expect(button("Save").disabled).toBe(true);
    await act(async () => type(title, "Answers in Brazilian Portuguese"));
    expect(button("Save").disabled).toBe(false);
    await act(async () => button("Save").click());
    await flush();
    const update = calls.find((call) => call.cmd === "memory_update");
    expect(update?.args).toMatchObject({ id: "a", change: { title: "Answers in Brazilian Portuguese", kind: "semantic", workspaceId: null } });
    expect(host.textContent).toContain("Answers in Brazilian Portuguese");
  });

  it("asks twice before it deletes, and drops the memory with its links", async () => {
    await act(async () => rows()[1]!.querySelector("button")!.click());
    await act(async () => button("Delete").click());
    expect(calls.some((call) => call.cmd === "memory_delete")).toBe(false);
    await act(async () => button("Keep it").click());
    expect(button("Delete")).toBeTruthy();
    await act(async () => button("Delete").click());
    await act(async () => button("Delete for good").click());
    await flush();
    expect(calls.find((call) => call.cmd === "memory_delete")?.args).toEqual({ id: "b" });
    expect(rows()).toHaveLength(2);
  });
});
