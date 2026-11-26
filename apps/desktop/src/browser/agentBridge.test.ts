import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ataraxia's page bridge (src-tauri/src/adapters/browser/agent.js), run in a jsdom page the way the
 * browser runs it in a real one: injected before the page's own scripts, then driven through
 * `__ataraxia.run`.
 */
const SOURCE = readFileSync(resolve(__dirname, "../../../../src-tauri/src/adapters/browser/agent.js"), "utf8");

type Bridge = {
  run(id: string, command: Record<string, unknown>): string;
  exec(id: string, fn: () => unknown): string;
  poll(id: string): string;
  drain(since?: number): string;
  meta(): string;
};

type Answer = { done?: boolean; pending?: boolean; value?: any; error?: string; gone?: boolean };

/* eslint-disable @typescript-eslint/no-explicit-any */
// Each test gets a window of its own: the bridge defines `__ataraxia` so that the page cannot
// replace it, which also means it cannot be installed twice in the same window.
let w: any;

const bridge = (): Bridge => w.__ataraxia;

function install() {
  w.eval(SOURCE);
}

let counter = 0;
/** Runs a command and follows it until it is done, as the app does. */
async function run(command: Record<string, unknown>): Promise<Answer> {
  const id = `t${++counter}`;
  const first = JSON.parse(bridge().run(id, command)) as Answer;
  if (!first.pending) return first;
  for (let i = 0; i < 400; i++) {
    await new Promise((done) => setTimeout(done, 5));
    const next = JSON.parse(bridge().poll(id)) as Answer;
    if (next.done || next.gone) return next;
  }
  throw new Error("never finished");
}

const drain = (since = 0) => JSON.parse(bridge().drain(since));

function page(html: string) {
  w.document.body.innerHTML = html;
}

beforeEach(() => {
  w = new JSDOM("<!doctype html><title>Test page</title><body></body>", {
    url: "http://localhost:3000/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  }).window;
  w.TextDecoder = TextDecoder;
  w.TextEncoder = TextEncoder;
  // jsdom has no layout: every element is a 100x20 box at the same place, which is enough to aim at.
  w.Element.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20, toJSON() {} };
  };
  w.document.elementFromPoint = () => null;
  w.Element.prototype.scrollIntoView = () => {};
});

describe("snapshot", () => {
  it("lists what can be acted on with refs, roles, names and state, and what is said on the page", async () => {
    page(`
      <header><nav aria-label="Main"><a href="/home">Home</a><a href="/docs">Docs</a></nav></header>
      <main>
        <h1>Welcome back</h1>
        <p>Sign in to continue.</p>
        <form>
          <label for="email">Email</label><input id="email" type="email" placeholder="you@example.com" required>
          <label>Password <input type="password" value="hunter2"></label>
          <label><input type="checkbox" checked> Remember me</label>
          <select aria-label="Country"><option>Brazil</option><option selected>Portugal</option></select>
          <button type="submit">Sign in</button>
          <button disabled>Save</button>
        </form>
      </main>
      <div hidden><button>Secret</button></div>
      <div style="display:none"><a href="/no">Nope</a></div>
      <div aria-hidden="true"><button>Aria hidden</button></div>`);
    install();
    const { value } = await run({ op: "snapshot" });
    expect(value).toContain('Page "Test page"');
    expect(value).toMatch(/navigation "Main":/);
    expect(value).toMatch(/\[e\d+\] link "Home" href=\/home/);
    expect(value).toContain('heading(1) "Welcome back"');
    expect(value).toContain('text "Sign in to continue."');
    expect(value).toMatch(/\[e\d+\] textbox "Email" required value="" placeholder="you@example.com"/);
    // A password is never read out.
    expect(value).toContain('value="••••"');
    expect(value).not.toContain("hunter2");
    expect(value).toMatch(/checkbox "Remember me" checked/);
    expect(value).toMatch(/combobox "Country" value="Portugal"/);
    expect(value).toContain("options: Brazil | Portugal");
    expect(value).toMatch(/button "Sign in"/);
    expect(value).toMatch(/button "Save" disabled/);
    for (const hidden of ["Secret", "Nope", "Aria hidden"]) expect(value).not.toContain(hidden);
  });

  it("does not say twice what a label already names", async () => {
    page(`<form><label for="e">Email</label><input id="e"><label>Name <input></label></form>`);
    install();
    const outline = (await run({ op: "snapshot" })).value as string;
    expect(outline.match(/Email/g)).toHaveLength(1);
    expect(outline).not.toMatch(/text "Email"/);
  });

  it("gives an element the same ref every time it is listed", async () => {
    page(`<button>One</button><button>Two</button>`);
    install();
    const first = (await run({ op: "snapshot" })).value as string;
    const second = (await run({ op: "snapshot" })).value as string;
    expect(first.match(/\[e\d+\] button "Two"/)![0]).toBe(second.match(/\[e\d+\] button "Two"/)![0]);
  });

  it("can be limited to a part of the page and cut to a size", async () => {
    page(`<section id="a"><button>Inside</button></section><button>Outside</button>`);
    install();
    const scoped = (await run({ op: "snapshot", selector: "#a" })).value as string;
    expect(scoped).toContain("Inside");
    expect(scoped).not.toContain("Outside");
    page(Array.from({ length: 200 }, (_, i) => `<button>Button number ${i}</button>`).join(""));
    const cut = (await run({ op: "snapshot", maxChars: 600 })).value as string;
    expect(cut).toContain("truncated at 600 characters");
    expect(cut.length).toBeLessThan(900);
  });

  it("says when there is nothing to act on, and when the scope matches nothing", async () => {
    page(``);
    install();
    expect(((await run({ op: "snapshot" })).value as string)).toContain("nothing visible to act on yet");
    expect((await run({ op: "snapshot", selector: "#nope" })).error).toContain("nothing matches #nope");
  });

  it("looks into open shadow roots and same-origin frames", async () => {
    page(`<div id="host"></div>`);
    const host = w.document.getElementById("host")!;
    host.attachShadow({ mode: "open" }).innerHTML = `<button>In shadow</button>`;
    install();
    expect(((await run({ op: "snapshot" })).value as string)).toContain('button "In shadow"');
  });
});

describe("click and the virtual mouse", () => {
  it("moves the mouse, sends the events in the order a real click does and reports what it clicked", async () => {
    page(`<button id="go">Go</button>`);
    install();
    const seen: string[] = [];
    const button = w.document.getElementById("go")!;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      button.addEventListener(type, () => seen.push(type));
    }
    const snapshot = (await run({ op: "snapshot" })).value as string;
    const ref = snapshot.match(/\[(e\d+)\] button "Go"/)![1];
    const answer = await run({ op: "click", target: { ref } });
    expect(answer.error).toBeUndefined();
    expect(answer.value.clicked).toBe('button "Go"');
    const wanted = ["mousedown", "mouseup", "click"];
    expect(seen.filter((type) => wanted.includes(type))).toEqual(wanted);
    // The virtual mouse and its caption are drawn in a shadow root of their own.
    expect(w.document.querySelector("[data-ataraxia-overlay]")).not.toBeNull();
  });

  it("finds an element by selector or by its text and says when the choice is not clear", async () => {
    page(`<button class="x">Alpha</button><button class="x">Beta</button>`);
    install();
    const clicked: string[] = [];
    w.document.querySelectorAll("button").forEach((b: HTMLElement) => b.addEventListener("click", () => clicked.push(b.textContent!)));
    expect((await run({ op: "click", target: { text: "Beta" } })).value.clicked).toBe('button "Beta"');
    expect((await run({ op: "click", target: { selector: ".x", nth: 0 } })).value.clicked).toBe('button "Alpha"');
    const unclear = await run({ op: "click", target: { selector: ".x" } });
    expect(unclear.error).toContain("2 elements match .x");
    expect(clicked).toEqual(["Beta", "Alpha"]);
    expect((await run({ op: "click", target: { text: "Gamma" } })).error).toContain('no visible element has the text "Gamma"');
    expect((await run({ op: "click", target: {} })).error).toContain("say what to act on");
  });

  it("refuses to click something that is covered, unless it is forced, and never a disabled one", async () => {
    page(`<button id="under">Under</button><div id="over" style="position:fixed">Cookie banner</div>`);
    install();
    const clicked = vi.fn();
    w.document.getElementById("under")!.addEventListener("click", clicked);
    w.document.elementFromPoint = () => w.document.getElementById("over");
    const blocked = await run({ op: "click", target: { selector: "#under" } });
    expect(blocked.error).toContain("is covered by <div#over>");
    expect(clicked).not.toHaveBeenCalled();
    expect((await run({ op: "click", target: { selector: "#under" }, force: true })).error).toBeUndefined();
    expect(clicked).toHaveBeenCalledTimes(1);

    page(`<button id="off" disabled>Off</button>`);
    w.document.elementFromPoint = () => null;
    expect((await run({ op: "click", target: { selector: "#off" } })).error).toContain("is disabled");
  });

  it("follows a link, double clicks and right clicks", async () => {
    page(`<div id="d">Thing</div>`);
    install();
    const seen: string[] = [];
    const el = w.document.getElementById("d")!;
    el.setAttribute("onclick", "");
    for (const type of ["click", "dblclick", "contextmenu"]) el.addEventListener(type, () => seen.push(type));
    await run({ op: "click", target: { selector: "#d" }, count: 2 });
    await run({ op: "click", target: { selector: "#d" }, button: "right" });
    expect(seen).toEqual(["click", "click", "dblclick", "contextmenu"]);
  });

  it("follows a link with the element's own click, which every browser acts on, and tells the page", async () => {
    page(`<a id="l" href="#next"><span id="inner">Next page</span></a>`);
    install();
    const seen: string[] = [];
    w.document.getElementById("l")!.addEventListener("click", (event: Event) => seen.push(`click ${(event.target as HTMLElement).id}`));
    await run({ op: "click", target: { selector: "#l" } });
    await new Promise((done) => setTimeout(done, 20));
    expect(w.location.hash).toBe("#next");
    expect(seen).toHaveLength(1);
  });

  it("aims at a point on the page when it is given one", async () => {
    page(`<div></div>`);
    install();
    expect((await run({ op: "click", target: { x: 40, y: 50 } })).value.clicked).toBeDefined();
  });

  it("says when a ref has gone from the page", async () => {
    page(`<button>Temporary</button>`);
    install();
    const ref = ((await run({ op: "snapshot" })).value as string).match(/\[(e\d+)\]/)![1];
    w.document.body.innerHTML = "";
    expect((await run({ op: "click", target: { ref } })).error).toContain(`ref ${ref} is no longer on the page`);
    expect((await run({ op: "click", target: { ref: "e999" } })).error).toContain("no longer on the page");
  });
});

describe("typing and keys", () => {
  it("types into a field the way a user does, through the field's own setter, with every event", async () => {
    page(`<input id="q">`);
    install();
    const q = w.document.getElementById("q") as HTMLInputElement;
    const events: string[] = [];
    for (const type of ["keydown", "beforeinput", "input", "keyup", "change"]) q.addEventListener(type, () => events.push(type));
    const answer = await run({ op: "type", target: { selector: "#q" }, text: "hi" });
    expect(answer.value.typed).toBe("2 characters");
    expect(q.value).toBe("hi");
    expect(events.filter((e) => e === "input")).toHaveLength(2);
    expect(events.at(-1)).toBe("change");
  });

  it("replaces what was there unless asked to append, and fills at once", async () => {
    page(`<input id="q" value="old"><textarea id="t"></textarea>`);
    install();
    const q = w.document.getElementById("q") as HTMLInputElement;
    await run({ op: "type", target: { selector: "#q" }, text: "new" });
    expect(q.value).toBe("new");
    await run({ op: "type", target: { selector: "#q" }, text: "!", append: true });
    expect(q.value).toBe("new!");
    await run({ op: "fill", target: { selector: "#t" }, text: "line one\nline two" });
    expect((w.document.getElementById("t") as HTMLTextAreaElement).value).toBe("line one\nline two");
  });

  it("updates a field a framework controls, which only reads the native setter's value", async () => {
    page(`<input id="q">`);
    install();
    const q = w.document.getElementById("q") as HTMLInputElement;
    let seen = "";
    q.addEventListener("input", () => (seen = q.value));
    Object.defineProperty(q, "value", { configurable: true, get: () => "", set: () => {} });
    await run({ op: "fill", target: { selector: "#q" }, text: "controlled" });
    expect(seen).toBe("");
    // The field's own value property was shadowed, but the prototype setter still stored it.
    delete (q as { value?: string }).value;
    expect(q.value).toBe("controlled");
  });

  it("submits a form with Enter, and not when the page stops the key", async () => {
    page(`<form id="f"><input id="a" name="a"></form>`);
    install();
    const form = w.document.getElementById("f") as HTMLFormElement;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener("submit", submitted);
    await run({ op: "press", key: "Enter", target: { selector: "#a" } });
    expect(submitted).toHaveBeenCalledTimes(1);
    w.document.getElementById("a")!.addEventListener("keydown", (event: Event) => event.preventDefault());
    await run({ op: "press", key: "Enter", target: { selector: "#a" } });
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("types and submits in one step", async () => {
    page(`<form id="f"><input id="a"></form>`);
    install();
    const submitted = vi.fn((event: Event) => event.preventDefault());
    w.document.getElementById("f")!.addEventListener("submit", submitted);
    const answer = await run({ op: "type", target: { selector: "#a" }, text: "x", submit: true });
    expect(answer.value.submitted).toBe(true);
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("moves the focus with Tab and clicks a button with Enter or Space", async () => {
    page(`<input id="a"><button id="b">B</button>`);
    install();
    (w.document.getElementById("a") as HTMLInputElement).focus();
    await run({ op: "press", key: "Tab" });
    expect(w.document.activeElement?.id).toBe("b");
    await run({ op: "press", key: "Shift+Tab" });
    expect(w.document.activeElement?.id).toBe("a");
    const clicked = vi.fn();
    w.document.getElementById("b")!.addEventListener("click", clicked);
    await run({ op: "press", key: "Enter", target: { selector: "#b" } });
    await run({ op: "press", key: " ", target: { selector: "#b" } });
    expect(clicked).toHaveBeenCalledTimes(2);
  });

  it("reports a key combination with its modifiers", async () => {
    page(`<input id="a" value="abc">`);
    install();
    const seen: KeyboardEvent[] = [];
    w.document.getElementById("a")!.addEventListener("keydown", (event: Event) => seen.push(event as KeyboardEvent));
    await run({ op: "press", key: "Control+Shift+K", target: { selector: "#a" } });
    expect(seen[0]).toMatchObject({ key: "K", ctrlKey: true, shiftKey: true, metaKey: false });
    await run({ op: "press", key: "cmd+a", target: { selector: "#a" } });
    expect(seen[1]).toMatchObject({ key: "a", metaKey: true });
  });
});

describe("select, check and scroll", () => {
  it("chooses an option by its text or value and says what the options are when it is not there", async () => {
    page(`<select id="s"><option value="br">Brazil</option><option value="pt">Portugal</option></select>`);
    install();
    const s = w.document.getElementById("s") as HTMLSelectElement;
    const changed = vi.fn();
    s.addEventListener("change", changed);
    expect((await run({ op: "select", target: { selector: "#s" }, value: "Portugal" })).value.selected).toEqual(["Portugal"]);
    expect(s.value).toBe("pt");
    await run({ op: "select", target: { selector: "#s" }, value: "br" });
    expect(s.value).toBe("br");
    expect(changed).toHaveBeenCalledTimes(2);
    const missing = await run({ op: "select", target: { selector: "#s" }, value: "Spain" });
    expect(missing.error).toContain('"Brazil", "Portugal"');
  });

  it("checks and unchecks and leaves a box that is already right alone", async () => {
    page(`<input id="c" type="checkbox">`);
    install();
    const c = w.document.getElementById("c") as HTMLInputElement;
    await run({ op: "check", target: { selector: "#c" } });
    expect(c.checked).toBe(true);
    await run({ op: "check", target: { selector: "#c" } });
    expect(c.checked).toBe(true);
    await run({ op: "uncheck", target: { selector: "#c" } });
    expect(c.checked).toBe(false);
  });

  it("scrolls by a distance, to the ends, and answers where it is", async () => {
    page(`<div style="height:5000px"></div>`);
    install();
    const by = vi.spyOn(w, "scrollBy").mockImplementation(() => {});
    await run({ op: "scroll", dy: 300 });
    expect(by).toHaveBeenCalledWith(0, 300);
    await run({ op: "scroll" });
    expect(by).toHaveBeenLastCalledWith(0, expect.any(Number));
    expect(by.mock.calls.at(-1)![1]).toBeGreaterThan(0);
    await run({ op: "scroll", to: "bottom" });
    expect(by.mock.calls.at(-1)![1]).toBeGreaterThan(1e6);
    expect((await run({ op: "scroll", dy: 1 })).value).toMatchObject({ scrollY: expect.any(Number), maxScrollY: expect.any(Number) });
  });
});

describe("waiting", () => {
  it("waits for text to appear, an element to go, or a plain pause", async () => {
    page(`<div id="box">Loading…</div>`);
    install();
    setTimeout(() => (w.document.getElementById("box")!.textContent = "Done loading"), 60);
    const found = await run({ op: "wait", text: "Done loading" });
    expect(found.value.waited).toBeGreaterThanOrEqual(0);
    page(`<div id="spinner">spin</div>`);
    setTimeout(() => w.document.getElementById("spinner")!.remove(), 60);
    expect((await run({ op: "wait", selectorGone: "#spinner" })).error).toBeUndefined();
    expect((await run({ op: "wait", ms: 20 })).value.waited).toBe(20);
  });

  it("treats what the app left null as not given", async () => {
    page(`<p>Welcome back</p>`);
    install();
    const answer = await run({ op: "wait", text: "Welcome", textGone: null, selector: null, selectorGone: null, url: null, idle: null, ms: null, timeout: 500 });
    expect(answer.error).toBeUndefined();
    const click = await run({ op: "click", target: { ref: null, selector: "p", text: null }, force: null });
    expect(click.error).toBeUndefined();
  });

  it("gives up with what it was waiting for", async () => {
    page(`<p>nothing</p>`);
    install();
    const answer = await run({ op: "wait", text: "never", timeout: 250 });
    expect(answer.error).toContain("timed out after 250ms waiting for text");
  });

  it("waits for the page's own requests to settle", async () => {
    page(``);
    const calls: string[] = [];
    w.fetch = (url: string) => {
      calls.push(url);
      return new Promise((done) => setTimeout(() => done(fakeResponse("{}", "application/json")), 80));
    };
    install();
    void w.fetch("/api/slow");
    const started = Date.now();
    await run({ op: "wait", idle: 50 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });
});

function fakeResponse(body: string, type: string, status = 200) {
  const bytes = new TextEncoder().encode(body);
  const make = (): Record<string, unknown> => ({
    status,
    statusText: status === 200 ? "OK" : "Error",
    ok: status < 400,
    url: "http://localhost/api",
    redirected: false,
    headers: new Map([["content-type", type]]),
    body: {
      getReader() {
        let sent = false;
        return {
          read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
          cancel: () => {},
        };
      },
    },
    clone: () => make(),
  });
  return make();
}

describe("network capture", () => {
  it("records a fetch with its request, response, timing and where it came from", async () => {
    w.fetch = async () => fakeResponse('{"items":[1,2]}', "application/json; charset=utf-8");
    install();
    const response = await w.fetch("/api/items?page=2", {
      method: "post",
      headers: { Authorization: "Bearer abc", "Content-Type": "application/json" },
      body: JSON.stringify({ q: "x" }),
    });
    expect(response).toBeDefined();
    await new Promise((done) => setTimeout(done, 20));
    const { net } = drain();
    const entry = net.find((item: any) => item.kind === "fetch");
    expect(entry).toMatchObject({
      method: "POST",
      url: "http://localhost:3000/api/items?page=2",
      status: 200,
      ok: true,
      done: true,
      mime: "application/json",
      reqBody: '{"q":"x"}',
      resBody: '{"items":[1,2]}',
    });
    expect(entry.reqHeaders).toMatchObject({ authorization: "Bearer abc", "content-type": "application/json" });
    expect(entry.resHeaders["content-type"]).toContain("application/json");
    expect(entry.duration).toBeGreaterThanOrEqual(0);
  });

  it("records a failed fetch and gives the error back to the page unchanged", async () => {
    w.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    install();
    await expect(w.fetch("/boom")).rejects.toThrow("Failed to fetch");
    const entry = drain().net[0];
    expect(entry).toMatchObject({ done: true, error: "Failed to fetch", status: 0 });
  });

  it("notes what it does not read: binary bodies and streams", async () => {
    w.fetch = async (url: string) =>
      url.includes("stream") ? fakeResponse("data: x", "text/event-stream") : fakeResponse("PNG", "image/png");
    install();
    const f = w.fetch;
    await f("/stream");
    await f("/image");
    await new Promise((done) => setTimeout(done, 10));
    const { net } = drain();
    expect(net.find((e: any) => e.url.endsWith("/stream")).resNote).toBe("[event stream]");
    expect(net.find((e: any) => e.url.endsWith("/image")).resNote).toBe("[image/png]");
    expect(net.every((e: any) => e.resBody === undefined)).toBe(true);
  });

  it("records an XMLHttpRequest with its headers, body and response", async () => {
    class FakeXhr {
      status = 0;
      statusText = "";
      responseText = "";
      responseType = "";
      listeners: Record<string, () => void> = {};
      open() {}
      setRequestHeader() {}
      addEventListener(name: string, fn: () => void) {
        this.listeners[name] = fn;
      }
      getAllResponseHeaders() {
        return "Content-Type: application/json\r\nX-Request-Id: 7\r\n";
      }
      send() {
        this.status = 201;
        this.statusText = "Created";
        this.responseText = '{"id":7}';
        this.listeners.loadend?.();
      }
    }
    w.XMLHttpRequest = FakeXhr;
    install();
    const xhr = new w.XMLHttpRequest();
    xhr.open("PUT", "/api/things/7");
    xhr.setRequestHeader("X-Token", "t");
    xhr.send('{"name":"x"}');
    const entry = drain().net.find((e: any) => e.kind === "xhr");
    expect(entry).toMatchObject({ method: "PUT", status: 201, done: true, reqBody: '{"name":"x"}', resBody: '{"id":7}', mime: "application/json" });
    expect(entry.reqHeaders).toEqual({ "x-token": "t" });
    expect(entry.resHeaders["x-request-id"]).toBe("7");
  });

  it("records a WebSocket's address and its first frames", async () => {
    class FakeSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      listeners: Record<string, ((e: unknown) => void)[]> = {};
      constructor(public url: string) {}
      addEventListener(name: string, fn: (e: unknown) => void) {
        (this.listeners[name] ||= []).push(fn);
      }
      send() {}
      emit(name: string, event: unknown) {
        this.listeners[name]?.forEach((fn) => fn(event));
      }
    }
    w.WebSocket = FakeSocket;
    install();
    const socket = new w.WebSocket("ws://localhost/live");
    socket.send("hello");
    socket.emit("message", { data: "welcome" });
    socket.emit("close", { code: 1000 });
    const entry = drain().net.find((e: any) => e.kind === "ws");
    expect(entry.url).toBe("ws://localhost/live");
    expect(entry.frames.map((f: any) => `${f.d}:${f.data}`)).toEqual(["out:hello", "in:welcome"]);
    expect(entry).toMatchObject({ done: true, closeCode: 1000 });
  });

  it("only returns what changed since the last time it was asked", async () => {
    w.fetch = async () => fakeResponse("{}", "application/json");
    install();
    const f = w.fetch;
    await f("/one");
    await new Promise((done) => setTimeout(done, 10));
    const first = drain();
    expect(first.net).toHaveLength(1);
    expect(drain(first.cursor).net).toHaveLength(0);
    await f("/two");
    await new Promise((done) => setTimeout(done, 10));
    const next = drain(first.cursor);
    expect(next.net.map((e: any) => e.url.split("/").pop())).toEqual(["two"]);
  });
});

describe("console and errors", () => {
  it("records console output with its level and still prints it", () => {
    const log = vi.spyOn(w.console, "log").mockImplementation(() => {});
    install();
    w.console.log("hello", { a: 1 }, [2]);
    w.console.error(new Error("bad"));
    w.console.warn("careful");
    const { console: lines } = drain();
    expect(lines.map((l: any) => l.level)).toEqual(["log", "error", "warn"]);
    expect(lines[0].text).toBe('hello {"a":1} [2]');
    expect(lines[1].text).toContain("Error: bad");
    expect(log).toHaveBeenCalledWith("hello", { a: 1 }, [2]);
  });

  it("records exceptions, rejections and resources that failed", () => {
    install();
    w.dispatchEvent(new w.ErrorEvent("error", { message: "boom", filename: "app.js", lineno: 3, colno: 9, error: new Error("boom") }));
    const rejection = new w.Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new TypeError("nope");
    w.dispatchEvent(rejection);
    const img = w.document.createElement("img");
    img.src = "http://localhost/missing.png";
    w.document.body.append(img);
    img.dispatchEvent(new w.Event("error"));
    const { errors } = drain();
    expect(errors.map((e: any) => e.kind)).toEqual(["exception", "rejection", "resource"]);
    expect(errors[0]).toMatchObject({ message: "boom", source: "app.js", line: 3, column: 9 });
    expect(errors[1].message).toContain("TypeError: nope");
    expect(errors[2].url).toContain("missing.png");
  });

  it("does not let a hostile argument break the page's own logging", () => {
    vi.spyOn(w.console, "log").mockImplementation(() => {});
    install();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const hostile = { get boom() { throw new Error("getter"); } };
    expect(() => w.console.log(loop, hostile, 10n, Symbol("s"), () => 1)).not.toThrow();
    expect(drain().console[0].text).toContain("[Circular]");
  });
});

describe("reading and inspecting", () => {
  it("finds elements by text or selector and hands out refs", async () => {
    page(`<a href="/a">Pricing</a><a href="/b">Pricing plans</a><button>Buy</button>`);
    install();
    const found = (await run({ op: "find", text: "pricing" })).value;
    expect(found.count).toBe(2);
    expect(found.matches[0]).toMatchObject({ role: "link", name: "Pricing" });
    expect((await run({ op: "find", selector: "button" })).value.matches[0].ref).toMatch(/^e\d+$/);
  });

  it("reads text, links, forms and tables", async () => {
    page(`<main><h1>Title</h1><a href="/x">Link x</a>
      <form action="/save" method="post"><input name="user" required><input type="password" name="pw" value="secret"></form>
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></main>`);
    install();
    expect((await run({ op: "read", mode: "text" })).value.text).toContain("Title");
    expect((await run({ op: "read", mode: "links" })).value.links[0]).toEqual({ text: "Link x", href: "http://localhost:3000/x" });
    const forms = (await run({ op: "read", mode: "forms" })).value.forms[0];
    expect(forms).toMatchObject({ method: "POST", action: "http://localhost:3000/save" });
    expect(forms.fields.find((f: any) => f.name === "pw").value).toBe("••••");
    expect((await run({ op: "read", mode: "table" })).value.rows).toEqual([["A", "B"], ["1", "2"]]);
    expect((await run({ op: "read", mode: "nonsense" })).error).toContain("unknown read mode");
  });

  it("inspects an element: where it is, how it is styled and what covers it", async () => {
    page(`<button id="b" class="primary big" data-x="1" style="color: red">Pay</button>`);
    install();
    const info = (await run({ op: "inspect", target: { selector: "#b" } })).value;
    expect(info).toMatchObject({ tag: "button", role: "button", name: "Pay", visible: true });
    expect(info.path).toContain("<button#b.primary.big>");
    expect(info.attributes["data-x"]).toBe("1");
    expect(info.box).toEqual({ x: 10, y: 10, width: 100, height: 20 });
    expect(info.styles.color).toMatch(/red|255, 0, 0/);
  });

  it("dumps the page's storage, with cookies", async () => {
    install();
    w.localStorage.setItem("token", "abc");
    w.sessionStorage.setItem("tab", "1");
    w.document.cookie = "theme=dark";
    const info = (await run({ op: "storage" })).value;
    expect(info.localStorage.token).toBe("abc");
    expect(info.sessionStorage.tab).toBe("1");
    expect(info.cookies).toContainEqual({ name: "theme", value: "dark" });
  });

  it("reports the page's timings and size", async () => {
    install();
    const info = (await run({ op: "performance" })).value;
    expect(info.url).toBeDefined();
    expect(info.dom.nodes).toBeGreaterThan(0);
  });
});

describe("the surface", () => {
  it("answers a command that has to wait with pending, then through poll, once", async () => {
    page(``);
    install();
    const first = JSON.parse(bridge().run("w1", { op: "wait", ms: 30 }));
    expect(first).toEqual({ pending: true });
    expect(JSON.parse(bridge().poll("w1"))).toEqual({ done: false });
    await new Promise((done) => setTimeout(done, 60));
    expect(JSON.parse(bridge().poll("w1"))).toMatchObject({ done: true, value: { waited: 30 } });
    // Read once: after that the page no longer knows it (as after a navigation).
    expect(JSON.parse(bridge().poll("w1"))).toEqual({ gone: true });
  });

  it("runs code the app hands it, awaiting promises and making the value safe", async () => {
    page(`<p id="p">hi</p>`);
    install();
    const first = JSON.parse(bridge().exec("c1", () => (async () => ({ n: 1, el: w.document.getElementById("p"), f() {}, big: 5n }))()));
    expect(first).toEqual({ pending: true });
    await new Promise((done) => setTimeout(done, 5));
    expect(JSON.parse(bridge().poll("c1")).value).toEqual({ n: 1, el: "<p#p>", f: "[Function f]", big: "5n" });
    expect(JSON.parse(bridge().exec("c2", () => { throw new Error("nope"); }))).toEqual({ done: true, error: "nope" });
  });

  it("says what the page is: its address, title, load state and pending requests", () => {
    page(``);
    install();
    expect(JSON.parse(bridge().meta())).toMatchObject({ title: "Test page", readyState: expect.any(String), pending: 0 });
  });

  it("refuses a command it does not know and cannot be replaced by the page", async () => {
    page(``);
    install();
    expect((await run({ op: "teleport" })).error).toContain("unknown command teleport");
    expect(() => {
      w.__ataraxia = {};
    }).toThrow();
    expect(Object.keys(w)).not.toContain("__ataraxia");
  });

  it("is installed once", () => {
    install();
    const first = w.__ataraxia;
    w.eval(SOURCE);
    expect(w.__ataraxia).toBe(first);
  });
});
