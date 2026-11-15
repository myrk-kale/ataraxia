// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerPicker } from "./ComposerPicker";
import { useComposerPicker } from "./useComposerPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ commands: vi.fn(), paths: vi.fn() }));
vi.mock("../lib/agent", () => ({
  agentListCommands: api.commands,
  sessionPaths: api.paths,
}));

function Harness({ commands = true, onKey }: { commands?: boolean; onKey?: () => void }) {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useComposerPicker({
    sessionId: "s1",
    draft,
    onDraft: setDraft,
    field,
    commands,
    agents: [{ id: "reviewer", label: "reviewer", description: "Reviews" }],
  });
  return (
    <div style={{ position: "relative" }}>
      <ComposerPicker
        active={picker.active}
        id={picker.listId}
        items={picker.open ? picker.items : []}
        label={picker.label}
        onHover={picker.hover}
        onPick={picker.pick}
      />
      <textarea
        ref={field}
        aria-activedescendant={picker.activeId}
        aria-label="Message"
        value={draft}
        onChange={(event) => picker.onChange(event.currentTarget)}
        onKeyDown={(event) => {
          if (!picker.onKeyDown(event)) {
            onKey?.();
          }
        }}
      />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const field = () => host.querySelector("textarea")!;
const rows = () => [...host.querySelectorAll('[role="option"]')].map((row) => row.textContent ?? "");

async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(field(), value);
    field().setSelectionRange(value.length, value.length);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

function press(key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    field().dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  // jsdom does not scroll.
  Element.prototype.scrollIntoView = vi.fn();
  api.commands.mockResolvedValue([
    { name: "review", description: "Review the changes", hint: "[branch]", source: null },
    { name: "compact", description: "Compact it", hint: null, source: "user" },
  ]);
  api.paths.mockResolvedValue([
    { path: "src/", dir: true, repository: null },
    { path: "src/main.rs", dir: false, repository: null },
    { path: "README.md", dir: false, repository: null },
  ]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("the / and @ pickers of the message field", () => {
  it("opens the agent's commands on a slash and narrows them as the name is typed", async () => {
    act(() => root.render(<Harness />));
    await type("/");
    expect(api.commands).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(2);
    await type("/comp");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("/compact");
    expect(field().getAttribute("aria-activedescendant")).toBeTruthy();
  });

  it("completes the command with Enter and leaves the message for the next Enter", async () => {
    const onKey = vi.fn();
    act(() => root.render(<Harness onKey={onKey} />));
    await type("/rev");
    const event = press("Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(field().value).toBe("/review ");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(onKey).not.toHaveBeenCalled();
    press("Enter");
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it("moves with the arrows, wrapping around, and chooses with Tab", async () => {
    act(() => root.render(<Harness />));
    await type("/");
    press("ArrowDown");
    expect(host.querySelectorAll('[aria-selected="true"]')[0].textContent).toContain("/compact");
    press("ArrowDown");
    expect(host.querySelectorAll('[aria-selected="true"]')[0].textContent).toContain("/review");
    press("ArrowUp");
    press("Tab");
    expect(field().value).toBe("/compact ");
  });

  it("closes on Escape without taking the key from the rest of the panel's handlers", async () => {
    act(() => root.render(<Harness />));
    await type("/");
    expect(rows()).toHaveLength(2);
    const event = press("Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(rows()).toHaveLength(0);
    // It stays closed while the same word is being typed.
    await type("/re");
    expect(rows()).toHaveLength(0);
  });

  it("offers the files, folders and agents on an at sign anywhere in the message", async () => {
    act(() => root.render(<Harness />));
    await type("look at @");
    expect(api.paths).toHaveBeenCalledTimes(1);
    expect(rows().some((row) => row.includes("reviewer"))).toBe(true);
    expect(rows().some((row) => row.includes("src/main.rs"))).toBe(true);
    await type("look at @main");
    expect(rows()).toHaveLength(1);
    press("Enter");
    expect(field().value).toBe("look at @src/main.rs ");
  });

  it("goes on inside a folder once it is chosen", async () => {
    act(() => root.render(<Harness />));
    await type("@sr");
    press("Enter");
    expect(field().value).toBe("@src/");
    expect(rows().some((row) => row.includes("src/main.rs"))).toBe(true);
  });

  it("does not offer commands where the message is not for the main agent", async () => {
    act(() => root.render(<Harness commands={false} />));
    await type("/rev");
    expect(rows()).toHaveLength(0);
    expect(api.commands).not.toHaveBeenCalled();
    await type("@main");
    expect(rows()).toHaveLength(1);
  });

  it("leaves Enter alone when nothing matches, so the message can be sent", async () => {
    const onKey = vi.fn();
    act(() => root.render(<Harness onKey={onKey} />));
    await type("/zzzz");
    expect(rows()).toHaveLength(0);
    press("Enter");
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(field().value).toBe("/zzzz");
  });

  it("reads the commands again each time the list opens", async () => {
    act(() => root.render(<Harness />));
    await type("/");
    await type("hello");
    await type("/");
    expect(api.commands).toHaveBeenCalledTimes(2);
  });
});
