// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type MenuEntry, type MenuTools, menuFor, registerTerminalSelection } from "./contextMenu";

function tools(selection = "") {
  return {
    selection,
    copyText: vi.fn<MenuTools["copyText"]>().mockResolvedValue(undefined),
    copyImage: vi.fn<MenuTools["copyImage"]>().mockResolvedValue(undefined),
    openLink: vi.fn<MenuTools["openLink"]>(),
  } satisfies MenuTools;
}

function place(html: string): HTMLElement {
  document.body.innerHTML = `<div id="host">${html}</div>`;
  return document.getElementById("host")!;
}

const names = (entries: MenuEntry[] | null) =>
  (entries ?? []).map((entry) =>
    entry.type === "predefined" ? entry.item : entry.type === "separator" ? "-" : entry.text,
  );

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("the right-click menu", () => {
  it("offers the editing actions in a text field", () => {
    place("<textarea id='t'></textarea>");
    expect(names(menuFor(document.getElementById("t"), tools()))).toEqual([
      "Undo",
      "Redo",
      "-",
      "Cut",
      "Copy",
      "Paste",
      "-",
      "SelectAll",
    ]);
    place("<input id='i' type='text'>");
    expect(menuFor(document.getElementById("i"), tools())).toHaveLength(8);
    place("<div id='c' contenteditable='true'>x</div>");
    expect(menuFor(document.getElementById("c"), tools())).toHaveLength(8);
  });

  it("does not offer to cut or paste where nothing can be typed", () => {
    place("<textarea id='t' readonly></textarea>");
    expect(menuFor(document.getElementById("t"), tools())).toEqual([]);
    expect(names(menuFor(document.getElementById("t"), tools("some words")))).toEqual(["Copy"]);
    place("<input id='b' type='checkbox'>");
    expect(menuFor(document.getElementById("b"), tools())).toEqual([]);
    place("<input id='d' type='text' disabled>");
    expect(menuFor(document.getElementById("d"), tools())).toEqual([]);
  });

  it("offers Copy for selected text on the page, and nothing without a selection", () => {
    place("<p id='p'>words in a message</p>");
    expect(names(menuFor(document.getElementById("p"), tools("words")))).toEqual(["Copy"]);
    expect(menuFor(document.getElementById("p"), tools(""))).toEqual([]);
    expect(menuFor(document.getElementById("p"), tools("   "))).toEqual([]);
  });

  it("takes a click on a piece of text for a click on the element around it", () => {
    place("<p id='p'>words</p>");
    const text = document.getElementById("p")!.firstChild;
    expect(names(menuFor(text, tools("words")))).toEqual(["Copy"]);
  });

  it("offers to open and copy a web link, and to copy the selection above them", () => {
    place("<a id='a' href='https://example.com/x'>link</a>");
    const entries = menuFor(document.getElementById("a"), tools("link"));
    expect(names(entries)).toEqual(["Copy", "-", "Open Link", "Copy Link Address"]);
    expect(names(menuFor(document.getElementById("a"), tools()))).toEqual([
      "Open Link",
      "Copy Link Address",
    ]);
  });

  it("runs the link actions with the address", async () => {
    place("<a id='a' href='https://example.com/x'><b id='in'>link</b></a>");
    const t = tools();
    const entries = menuFor(document.getElementById("in"), t) as MenuEntry[];
    const run = (text: string) =>
      (entries.find((entry) => entry.type === "action" && entry.text === text) as {
        run: () => void;
      }).run();
    run("Open Link");
    expect(t.openLink).toHaveBeenCalledWith("https://example.com/x");
    run("Copy Link Address");
    expect(t.copyText).toHaveBeenCalledWith("https://example.com/x");
  });

  it("leaves out a link that is not a web address", () => {
    place("<a id='a' href='javascript:alert(1)'>x</a><a id='f' href='file:///etc/passwd'>y</a>");
    expect(menuFor(document.getElementById("a"), tools())).toEqual([]);
    expect(menuFor(document.getElementById("f"), tools())).toEqual([]);
  });

  it("offers to copy a picture", () => {
    place("<img id='im' src='data:image/png;base64,AAAA' alt=''>");
    const t = tools();
    const entries = menuFor(document.getElementById("im"), t) as MenuEntry[];
    expect(names(entries)).toEqual(["Copy Image"]);
    (entries[0] as { run: () => void }).run();
    expect(t.copyImage).toHaveBeenCalledWith(document.getElementById("im"));
  });

  it("leaves the code editor to its own menu", () => {
    place("<div class='monaco-editor'><span id='m'>code</span></div>");
    expect(menuFor(document.getElementById("m"), tools("code"))).toBeNull();
  });

  it("offers Copy and Paste in the terminal, reading the selection from the terminal", async () => {
    place("<div id='term'><div class='xterm'><canvas id='c'></canvas></div></div>");
    let selected = "";
    const forget = registerTerminalSelection(document.getElementById("term")!, () => selected);
    const t = tools();

    let entries = menuFor(document.getElementById("c"), t) as MenuEntry[];
    expect(names(entries)).toEqual(["Copy", "Paste"]);
    expect((entries[0] as { enabled?: boolean }).enabled).toBe(false);

    selected = "ls -la";
    entries = menuFor(document.getElementById("c"), t) as MenuEntry[];
    expect((entries[0] as { enabled?: boolean }).enabled).toBe(true);
    await (entries[0] as { run: () => Promise<void> }).run();
    expect(t.copyText).toHaveBeenCalledWith("ls -la");

    forget();
    entries = menuFor(document.getElementById("c"), t) as MenuEntry[];
    expect((entries[0] as { enabled?: boolean }).enabled).toBe(false);
  });

  it("offers nothing on a click with no target", () => {
    expect(menuFor(null, tools())).toBeNull();
  });
});
