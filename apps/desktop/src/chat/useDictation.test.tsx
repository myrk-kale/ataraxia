// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDictationPrefs, setDictationPrefs } from "./dictationPrefs";
import { useDictation } from "./useDictation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const speech = vi.hoisted(() => ({
  status: { ready: true, streaming: true, needs_model: false, model_megabytes: 190, problem: null as string | null },
  transcribe: vi.fn<(wav: string, quick?: boolean) => Promise<string>>(),
}));
vi.mock("../lib/speech", () => ({
  speechStatus: () => Promise.resolve(speech.status),
  speechTranscribe: (wav: string, quick?: boolean) => speech.transcribe(wav, quick),
  speechWarmup: () => Promise.resolve(),
}));

/** What the window's audio is made of, as far as dictation touches it: 4096 samples at 16 kHz a frame. */
const FRAME = 4096;
const processors: { onaudioprocess: ((event: unknown) => void) | null }[] = [];
const stopped = vi.fn();

class FakeAudioContext {
  sampleRate = 16000;
  destination = {};
  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  createScriptProcessor() {
    const processor = { onaudioprocess: null as ((event: unknown) => void) | null, connect: () => undefined, disconnect: () => undefined };
    processors.push(processor);
    return processor;
  }
  close() {
    return Promise.resolve();
  }
}

let host: HTMLDivElement;
let root: Root;
let api: { current: ReturnType<typeof useDictation> | null };
let texts: string[];
let problems: string[];

function Harness() {
  const dictation = useDictation({
    onText: (text) => texts.push(text),
    onProblem: (message) => problems.push(message),
    onNeedsModel: () => undefined,
  });
  api.current = dictation;
  return null;
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The microphone hears `frames` stretches of sound at `level` (RMS). */
async function hear(level: number, frames: number) {
  for (let i = 0; i < frames; i += 1) {
    const processor = processors.at(-1);
    await act(async () => {
      processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(FRAME).fill(level) } });
    });
  }
}

async function begin() {
  await act(async () => api.current?.toggle());
  await flush();
}

beforeEach(() => {
  window.localStorage.clear();
  resetDictationPrefs();
  // 750 ms is three of the stretches fed below, so the tests can count them.
  setDictationPrefs({ autoStop: true, silenceMs: 750 });
  processors.length = 0;
  texts = [];
  problems = [];
  api = { current: null };
  speech.status = { ready: true, streaming: true, needs_model: false, model_megabytes: 190, problem: null };
  speech.transcribe.mockReset();
  speech.transcribe.mockImplementation((_wav, quick) => Promise.resolve(quick ? "olá" : "olá mundo"));
  stopped.mockReset();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: stopped }] }) },
  });
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  host.remove();
});

describe("dictating into the message field", () => {
  it("writes a phrase when the person pauses after it, and ends by itself after the quiet", async () => {
    await begin();
    expect(api.current?.state).toBe("recording");
    await hear(0.002, 1);
    await hear(0.1, 4);
    expect(api.current?.listening).toBe("hearing");
    // 512 ms of quiet closes the phrase: it is written while the recording goes on.
    await hear(0.002, 2);
    await flush();
    expect(texts).toEqual(["olá mundo"]);
    expect(api.current?.state).toBe("recording");
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
    expect(speech.transcribe.mock.calls[0]?.[1]).toBe(false);
    // 768 ms of quiet ends it, with nothing left to write.
    await hear(0.002, 1);
    await flush();
    expect(api.current?.state).toBe("idle");
    expect(stopped).toHaveBeenCalled();
    expect(texts).toEqual(["olá mundo"]);
    expect(problems).toEqual([]);
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
  });

  it("waits as long as the settings say before ending by itself", async () => {
    setDictationPrefs({ silenceMs: 2000 });
    await begin();
    await hear(0.1, 4);
    await hear(0.002, 7);
    await flush();
    expect(api.current?.state).toBe("recording");
    await hear(0.002, 1);
    await flush();
    expect(api.current?.state).toBe("idle");
    expect(texts).toEqual(["olá mundo"]);
  });

  it("with stopping by silence off, records through any quiet until it is stopped", async () => {
    setDictationPrefs({ autoStop: false });
    await begin();
    expect(api.current?.autoStop).toBe(false);
    // Nothing said for far longer than it would normally give up after.
    await hear(0.002, 60);
    expect(api.current?.state).toBe("recording");
    await hear(0.1, 4);
    await hear(0.002, 2);
    await flush();
    expect(texts).toEqual(["olá mundo"]);
    // A long quiet after speech does not end it either, and the stop bar stays empty.
    await hear(0.002, 60);
    await flush();
    expect(api.current?.state).toBe("recording");
    expect(api.current?.silence).toBe(0);
    await hear(0.1, 3);
    await act(async () => api.current?.toggle());
    await flush();
    expect(api.current?.state).toBe("idle");
    expect(texts).toEqual(["olá mundo", "olá mundo"]);
    expect(problems).toEqual([]);
  });

  it("writes each phrase as it is closed, in order, and the last one when it stops", async () => {
    let n = 0;
    speech.transcribe.mockImplementation(() => Promise.resolve(["um", "dois", "três"][n++] ?? ""));
    await begin();
    await hear(0.1, 4);
    await hear(0.002, 2);
    await flush();
    await hear(0.1, 4);
    await hear(0.002, 2);
    await flush();
    expect(texts).toEqual(["um", "dois"]);
    await hear(0.1, 3);
    await act(async () => api.current?.toggle());
    await flush();
    expect(texts).toEqual(["um", "dois", "três"]);
    expect(api.current?.state).toBe("idle");
  });

  it("does not stop while the person has not said anything yet, and says so when it gives up", async () => {
    await begin();
    await hear(0.002, 20);
    expect(api.current?.state).toBe("recording");
    await hear(0.002, 20);
    await flush();
    expect(api.current?.state).toBe("idle");
    expect(problems).toEqual(["Nothing was heard. Check the microphone and try again."]);
    expect(speech.transcribe).not.toHaveBeenCalled();
  });

  it("shows what is being said while the person goes on", async () => {
    // Only the interval that asks for previews is faked; the rest of the test waits for real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await begin();
    await hear(0.1, 5);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    await flush();
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
    expect(speech.transcribe.mock.calls[0]?.[1]).toBe(true);
    expect(api.current?.partial).toBe("olá");
    // Nothing is written until a phrase is closed.
    expect(texts).toEqual([]);
  });

  it("listens to the whole recording at the end when the engine cannot follow along", async () => {
    speech.status = { ...speech.status, streaming: false };
    await begin();
    await hear(0.1, 4);
    await hear(0.002, 2);
    await flush();
    expect(speech.transcribe).not.toHaveBeenCalled();
    await hear(0.002, 1);
    await flush();
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
    expect(texts).toEqual(["olá mundo"]);
    expect(api.current?.state).toBe("idle");
  });

  it("throws away what was not written when cancelled, and keeps what was", async () => {
    speech.transcribe.mockImplementation((_wav, quick) => Promise.resolve(quick ? "pré" : "primeira"));
    await begin();
    await hear(0.1, 4);
    await hear(0.002, 2);
    await flush();
    await hear(0.1, 4);
    await act(async () => api.current?.cancel());
    await flush();
    expect(texts).toEqual(["primeira"]);
    expect(api.current?.state).toBe("idle");
    expect(api.current?.partial).toBe("");
  });

  it("reports a microphone that is blocked", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException("no", "NotAllowedError")) },
    });
    await begin();
    expect(api.current?.state).toBe("idle");
    expect(problems[0]).toContain("microphone is blocked");
  });
});
