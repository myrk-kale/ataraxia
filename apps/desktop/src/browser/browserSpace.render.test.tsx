// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBrowserForTests, type BrowserTab, type LogView } from "../lib/browser";
import { BrowserNotice } from "./BrowserNotice";
import { BrowserSpace } from "./BrowserSpace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
let logs: LogView = { console: [], errors: [], net: [], mark: 0 };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "browser_logs") return Promise.resolve(logs);
    if (cmd === "browser_request_as") return Promise.resolve("curl 'https://shop.test/api/login'");
    if (cmd === "browser_screenshot") return Promise.resolve("");
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

class FakeObserver {
  observe() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeObserver;

function tab(id: number, over: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id,
    url: `https://site${id}.test/`,
    title: `Site ${id}`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    favicon: null,
    profile: "user",
    agentControl: false,
    errors: 0,
    failedRequests: 0,
    loadError: null,
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;
const errors: string[] = [];
const sent = (cmd: string) => calls.filter((call) => call.cmd === cmd);
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const byText = (text: string) => [...host.querySelectorAll<HTMLElement>("button")].find((item) => item.textContent?.includes(text))!;

async function render(props: { visible?: boolean; overlayOpen?: boolean } = {}) {
  await act(async () => {
    root.render(<BrowserSpace overlayOpen={props.overlayOpen ?? false} visible={props.visible ?? true} onError={(message) => errors.push(message)} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function write(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  calls.length = 0;
  errors.length = 0;
  logs = { console: [], errors: [], net: [], mark: 0 };
  window.localStorage.clear();
  resetBrowserForTests();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the browser space with no tab", () => {
  it("offers a start page, opens what is typed in a tab and keeps the page out of sight", async () => {
    await render();
    expect(host.textContent).toContain("A page you can read together with your agent");
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search or enter an address"]')!;
    write(input, "example.com");
    await act(async () => {
      input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(sent("browser_open")[0]?.args).toEqual({ url: "example.com" });
    // With nothing to show, no native page is on screen.
    expect(sent("browser_set_visible").at(-1)?.args).toEqual({ visible: false });
    expect(host.textContent).toContain("own cookies and logins");
  });

  it("opens a new tab from the plus button", async () => {
    await render();
    await act(async () => button("New tab").click());
    expect(sent("browser_open")[0]?.args).toEqual({ url: null });
  });
});

describe("tabs", () => {
  beforeEach(() => {
    resetBrowserForTests({
      tabs: [tab(1, { canGoBack: true }), tab(2, { profile: "agent", agentControl: true }), tab(3, { loading: true, title: "" })],
      active: 1,
      agentsAllowed: true,
    });
  });

  it("lists them, marks the agent's, and switches or closes on a click", async () => {
    await render();
    const tabs = [...host.querySelectorAll('[role="tab"]')];
    expect(tabs.map((item) => item.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(host.querySelector('[aria-label="Opened by an agent"]')).not.toBeNull();
    expect(host.textContent).toContain("site3.test");
    await act(async () => (tabs[1] as HTMLElement).click());
    expect(sent("browser_activate")[0]?.args).toEqual({ id: 2 });
    await act(async () => button("Close Site 2").click());
    expect(sent("browser_close")[0]?.args).toEqual({ id: 2 });
  });

  it("shows the address of the tab and goes where the person types, back and reload included", async () => {
    await render();
    const address = host.querySelector<HTMLInputElement>('input[aria-label="Address"]')!;
    expect(address.value).toBe("site1.test");
    write(address, "other.test/path");
    await act(async () => {
      address.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(sent("browser_navigate")[0]?.args).toEqual({ id: 1, input: "other.test/path" });
    await act(async () => button("Back").click());
    expect(sent("browser_go")[0]?.args).toEqual({ id: 1, movement: "back" });
    await act(async () => button("Reload").click());
    expect(sent("browser_go")[1]?.args).toEqual({ id: 1, movement: "reload" });
    expect(button("Forward").disabled).toBe(true);
  });

  it("puts the page where the box is and tells the app when it is not on screen", async () => {
    await render();
    expect(sent("browser_set_visible").at(-1)?.args).toEqual({ visible: true });
    await render({ visible: false });
    expect(sent("browser_set_visible").at(-1)?.args).toEqual({ visible: false });
    await render({ visible: true, overlayOpen: true });
    expect(sent("browser_set_visible").at(-1)?.args).toEqual({ visible: false });
    expect(host.textContent).toContain("Paused while something is open over it");
  });

  it("hands a tab of the person's to an agent, and takes it back, only when asked", async () => {
    await render();
    const share = button("Let agents use this tab");
    expect(share.getAttribute("aria-pressed")).toBe("false");
    await act(async () => share.click());
    expect(sent("browser_set_agent_control")[0]?.args).toEqual({ id: 1, allowed: true });
    // An agent's own tab has nothing to hand over: it says whose it is.
    await act(async () => (host.querySelectorAll('[role="tab"]')[1] as HTMLElement).click());
    resetBrowserForTests({ tabs: [tab(1), tab(2, { profile: "agent", agentControl: true })], active: 2, agentsAllowed: true });
    await render();
    expect(host.textContent).toContain("Agent tab");
    expect(host.querySelector('button[aria-label="Let agents use this tab"]')).toBeNull();
  });

  it("cannot share a tab while agents are switched off", async () => {
    resetBrowserForTests({ tabs: [tab(1)], active: 1, agentsAllowed: false });
    await render();
    expect(button("Let agents use this tab").disabled).toBe(true);
  });

  it("says why a page did not load", async () => {
    resetBrowserForTests({ tabs: [tab(1, { loadError: "the page did not load: it was blocked" })], active: 1, agentsAllowed: true });
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("did not load");
  });

  it("turns agents on and off from the menu and clears what their tabs stored", async () => {
    await render();
    await act(async () => button("Browser menu").click());
    expect(sent("browser_set_visible").at(-1)?.args).toEqual({ visible: false });
    const toggle = host.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(sent("browser_set_agents_allowed")[0]?.args).toEqual({ allowed: false });
    await act(async () => byText("Clear what agents").click());
    expect(sent("browser_clear_data")[0]?.args).toEqual({ profile: "agent" });
  });
});

describe("an agent at work", () => {
  it("is said in the tab and the person can take the tab over", async () => {
    resetBrowserForTests({ tabs: [tab(1, { agentControl: true })], active: 1, agentsAllowed: true }, { tab: 1, busy: true, action: "click" });
    await render();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("An agent is using this tab (click)");
    await act(async () => byText("Take over").click());
    expect(sent("browser_set_agent_control")[0]?.args).toEqual({ id: 1, allowed: false });
  });

  it("is said elsewhere with a way to go and watch, which can be waved off", async () => {
    resetBrowserForTests({ tabs: [], active: null, agentsAllowed: true }, { tab: 1, busy: true, action: "snapshot" });
    const watched = vi.fn();
    await act(async () => root.render(<BrowserNotice inBrowser={false} onWatch={watched} />));
    expect(host.textContent).toContain("An agent is using the browser");
    await act(async () => byText("Watch").click());
    expect(watched).toHaveBeenCalled();
    await act(async () => button("Dismiss").click());
    expect(host.textContent).toBe("");
    // In the browser itself there is nothing to announce.
    resetBrowserForTests({ tabs: [], active: null, agentsAllowed: true }, { tab: 1, busy: true, action: "click" });
    await act(async () => root.render(<BrowserNotice inBrowser onWatch={watched} />));
    expect(host.textContent).toBe("");
  });
});

describe("developer tools", () => {
  const entry = (over: Record<string, unknown>) => ({
    id: "a", kind: "fetch", method: "POST", url: "https://site1.test/api/login", page: "https://site1.test/", t: 0, status: 401, statusText: "Unauthorized", done: true, duration: 13,
    reqHeaders: { "content-type": "application/json" }, reqBody: '{"email":"x"}', resHeaders: {}, resBody: '{"error":"bad"}', resTruncated: false, resSize: 15, mime: "application/json", frames: [], seq: 5, ...over,
  });

  beforeEach(() => {
    resetBrowserForTests({ tabs: [tab(1, { errors: 2, failedRequests: 1 })], active: 1, agentsAllowed: true });
    logs = {
      console: [{ seq: 1, level: "log", text: "booted", t: 1, page: "" }, { seq: 3, level: "error", text: "login failed 401", t: 3, page: "" }],
      errors: [{ seq: 2, kind: "exception", message: "TypeError: x", t: 2, page: "" }],
      net: [entry({}) as never, entry({ id: "b", kind: "resource", url: "https://site1.test/app.js", status: 200, method: "GET", seq: 6 }) as never],
      mark: 6,
    };
  });

  async function open() {
    await render();
    await act(async () => button("Developer tools").click());
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }

  it("shows the console with what was logged and filters it by level", async () => {
    await open();
    const panel = host.querySelector('section[aria-label="Developer tools"]')!;
    expect(panel.textContent).toContain("booted");
    expect(panel.textContent).toContain("TypeError: x");
    await act(async () => byText("Error").click());
    expect(panel.querySelector('[role="log"]')!.textContent).not.toContain("booted");
    expect(panel.querySelector('[role="log"]')!.textContent).toContain("login failed 401");
    expect(window.localStorage.getItem("ataraxia.browser.debugOpen")).toBe("1");
  });

  it("lists the page's own calls, opens one, and copies it as a command", async () => {
    await open();
    await act(async () => byText("Network").click());
    const rows = [...host.querySelectorAll('[role="row"][type="button"], button[role="row"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("/api/login");
    expect(rows[0]!.textContent).toContain("401");
    await act(async () => (rows[0] as HTMLElement).click());
    const details = host.querySelector('[aria-label="Request details"]')!;
    expect(details.textContent).toContain('"error": "bad"');
    expect(details.textContent).toContain("content-type");
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } } });
    await act(async () => byText("cURL").click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(sent("browser_request_as")[0]?.args).toEqual({ id: 1, request: "a", form: "curl" });
    expect(copied[0]).toContain("curl 'https://shop.test/api/login'");
    // The files the page loaded are one switch away.
    await act(async () => byText("Fetch / XHR").click());
    expect(host.querySelectorAll('button[role="row"]')).toHaveLength(2);
  });

  it("clears the logs and closes", async () => {
    await open();
    await act(async () => byText("Clear").click());
    expect(sent("browser_clear_logs")[0]?.args).toEqual({ id: 1 });
    await act(async () => button("Close developer tools").click());
    expect(host.querySelector('section[aria-label="Developer tools"]')).toBeNull();
  });
});
