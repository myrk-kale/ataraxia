// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechModelDialog } from "./SpeechModelDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: string[] = [];
let fail = false;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    calls.push(cmd);
    if (cmd === "speech_download" && fail) {
      return Promise.reject(new Error("error[io]: could not download the speech model: offline"));
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

let host: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((item) => item.textContent?.includes(label)) as HTMLButtonElement | undefined;

beforeEach(() => {
  calls.length = 0;
  fail = false;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("asking before the speech model is downloaded", () => {
  it("says what it is and how big, and downloads nothing until the person agrees", async () => {
    act(() => root.render(<SpeechModelDialog isOpen megabytes={574} onClose={() => undefined} onReady={() => undefined} />));
    await flush();
    const text = document.body.textContent ?? "";
    expect(text).toContain("about 574 MB");
    expect(text).toContain("never sent");
    expect(calls).not.toContain("speech_download");
    expect(button("Download 574 MB")).toBeDefined();
  });

  it("downloads on agreement and tells the chat it can listen", async () => {
    const ready = vi.fn();
    act(() => root.render(<SpeechModelDialog isOpen megabytes={574} onClose={() => undefined} onReady={ready} />));
    await flush();
    await act(async () => button("Download 574 MB")!.click());
    await flush();
    expect(calls).toContain("speech_download");
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("shows why a download failed and offers to try again", async () => {
    fail = true;
    const ready = vi.fn();
    act(() => root.render(<SpeechModelDialog isOpen megabytes={574} onClose={() => undefined} onReady={ready} />));
    await flush();
    await act(async () => button("Download 574 MB")!.click());
    await flush();
    expect(ready).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("offline");
    expect(button("Try again")).toBeDefined();
  });
});
