// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerPicker } from "./ComposerPicker";
import { useComposerPicker } from "./useComposerPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ commands: vi.fn(), paths: vi.fn(), chats: vi.fn() }));
vi.mock("../lib/agent", () => ({
  agentListComposerResources: api.commands,
  sessionPaths: api.paths,
  sessionChats: api.chats,
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
    { kind: "command", name: "help", description: "List Ataraxia commands", hint: null, source: "Ataraxia" },
    { kind: "command", name: "new", description: "Create a new chat and keep this one", hint: null, source: "Ataraxia" },
    { kind: "command", name: "compact", description: "Compact this conversation", hint: null, source: "Ataraxia" },
    { kind: "command", name: "stop", description: "Stop the current run", hint: null, source: "Ataraxia" },
  ]);
  api.paths.mockResolvedValue([
    { path: "src/", dir: true, repository: null },
    { path: "src/main.rs", dir: false, repository: null },
    { path: "README.md", dir: false, repository: null },
  ]);
  api.chats.mockResolvedValue([
    { id: "aaaaaaaa-1111-4000-8000-000000000001", title: "Fix login redirect", updated_at: "" },
    { id: "bbbbbbbb-2222-4000-8000-000000000002", title: "Release notes", updated_at: "" },
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
  it("opens Ataraxia's commands on a slash and narrows them as the name is typed", async () => {
    act(() => root.render(<Harness />));
    await type("/");
    expect(api.commands).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(4);
    await type("/comp");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("/compact");
    expect(field().getAttribute("aria-activedescendant")).toBeTruthy();
  });

  it("completes an Ataraxia command and leaves the message for the next Enter", async () => {
    const onKey = vi.fn();
    act(() => root.render(<Harness onKey={onKey} />));
    await type("/new");
    const event = press("Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(field().value).toBe("/new ");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(onKey).not.toHaveBeenCalled();
    press("Enter");
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it("inserts only the skill name and lets the user add instructions", async () => {
    api.commands.mockResolvedValue([
      { kind: "skill", name: "release", description: "Prepare a release", hint: null, source: null },
    ]);
    const onKey = vi.fn();
    act(() => root.render(<Harness onKey={onKey} />));
    await type("/rel");
    press("Enter");
    expect(field().value).toBe("/release ");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(onKey).not.toHaveBeenCalled();

    await type("/release prepare the minor release");
    press("Enter");
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it("moves with the arrows, wrapping around, and chooses with Tab", async () => {
    act(() => root.render(<Harness />));
    await type("/");
    press("ArrowDown");
    expect(host.querySelectorAll('[aria-selected="true"]')[0].textContent).toContain("/new");
    press("ArrowDown");
    expect(host.querySelectorAll('[aria-selected="true"]')[0].textContent).toContain("/compact");
    press("ArrowUp");
    press("Tab");
    expect(field().value).toBe("/new ");
  });

  it("closes on Escape without taking the key from the rest of the panel's handlers", async () => {
    act(() => root.render(<Harness />));
    await type("/");
    expect(rows()).toHaveLength(4);
    const event = press("Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(rows()).toHaveLength(0);
    // It stays closed while the same word is being typed.
    await type("/re");
    expect(rows()).toHaveLength(0);
  });

  it("offers files but not folders or agents on an at sign anywhere in the message", async () => {
    act(() => root.render(<Harness />));
    await type("look at @");
    expect(api.paths).toHaveBeenCalledTimes(1);
    expect(rows().some((row) => row.includes("reviewer"))).toBe(false);
    expect(rows().some((row) => row.includes("src/main.rs"))).toBe(true);
    await type("look at @main");
    expect(rows()).toHaveLength(1);
    press("Enter");
    expect(field().value).toBe("look at @src/main.rs ");
  });

  it("offers the other conversations of the workspace on an at sign and points at one by its title", async () => {
    act(() => root.render(<Harness />));
    await type("@login");
    expect(api.chats).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("Fix login redirect");
    press("Enter");
    expect(field().value).toBe('@"chat:Fix login redirect" ');
    // Typing chat: shows the conversations and not the files.
    await type("@chat:");
    expect(rows().map((row) => row.includes("Conversation"))).toEqual([true, true]);
    expect(rows().some((row) => row.includes("src/main.rs"))).toBe(false);
  });

  it("selects a matching file directly instead of navigating into a folder", async () => {
    act(() => root.render(<Harness />));
    await type("@sr");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("src/main.rs");
    press("Enter");
    expect(field().value).toBe("@src/main.rs ");
    expect(rows()).toHaveLength(0);
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
