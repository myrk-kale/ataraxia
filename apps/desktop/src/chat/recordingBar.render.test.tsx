// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clock, RecordingBar, tail } from "./RecordingBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the recording indicator", () => {
  it("shows nothing when there is no dictation", () => {
    act(() => root.render(<RecordingBar listening="waiting" loudness={0} partial="" silence={0} state="idle" />));
    expect(host.textContent).toBe("");
  });

  it("says what the microphone is making of the room, and shows the words so far", () => {
    act(() => root.render(<RecordingBar listening="waiting" loudness={0} partial="" silence={0} state="recording" />));
    expect(host.querySelector("[role=status]")?.textContent).toBe("Listening. Say something");
    act(() => root.render(<RecordingBar listening="hearing" loudness={0.1} partial="abra as configurações" silence={0} state="recording" />));
    expect(host.querySelector("[role=status]")?.textContent).toBe("Hearing you");
    expect(host.textContent).toContain("abra as configurações");
    act(() => root.render(<RecordingBar listening="pausing" loudness={0} partial="abra as configurações" silence={0.5} state="recording" />));
    expect(host.querySelector("[role=status]")?.textContent).toContain("stops if you stay quiet");
    const fill = host.querySelector<HTMLElement>("[style*='width: 50%']");
    expect(fill).not.toBeNull();
  });

  it("says when it is writing the last words", () => {
    act(() => root.render(<RecordingBar listening="waiting" loudness={0} partial="" silence={0} state="transcribing" />));
    expect(host.querySelector("[role=status]")?.textContent).toBe("Writing what you said…");
  });

  it("writes the time as minutes and seconds", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(7.9)).toBe("0:07");
    expect(clock(75)).toBe("1:15");
  });

  it("shows the end of a long text, cut at a word", () => {
    expect(tail("  short   text ")).toBe("short text");
    const long = `${"palavra ".repeat(40)}final`;
    const cut = tail(long, 30);
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.endsWith("final")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(31);
  });
});
