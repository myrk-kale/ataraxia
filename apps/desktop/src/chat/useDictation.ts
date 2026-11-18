import { useCallback, useEffect, useRef, useState } from "react";
import { speechStatus, speechTranscribe } from "../lib/speech";
import { encodeWav, isSilent, level, mergeChunks, resample, SPEECH_RATE, toBase64 } from "./wav";

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

/** A dictation longer than this stops by itself: it is a message, and the engine has a limit too. */
const MAX_SECONDS = 150;

function problemText(err: unknown): string {
  if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
    return "The microphone is blocked. Allow Ataraxia to use it in the system settings, then try again.";
  }
  if (err instanceof DOMException && err.name === "NotFoundError") {
    return "No microphone was found.";
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dictation for the message field: records from the microphone, and on stop turns the recording
 * into text with the Whisper engine on this computer, which `onText` receives. Nothing leaves the
 * machine. `toggle` starts and stops; `cancel` throws the recording away.
 */
export function useDictation({ onText, onProblem }: { onText: (text: string) => void; onProblem: (message: string) => void }) {
  const [state, setState] = useState<DictationState>("idle");
  const [loudness, setLoudness] = useState(0);
  const session = useRef<{
    stream: MediaStream;
    context: AudioContext;
    processor: ScriptProcessorNode;
    source: MediaStreamAudioSourceNode;
    chunks: Float32Array[];
    timer: number;
  } | null>(null);
  const live = useRef(true);
  const handlers = useRef({ onText, onProblem });
  handlers.current = { onText, onProblem };
  const stateRef = useRef(state);
  stateRef.current = state;

  const supported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

  const release = useCallback(() => {
    const current = session.current;
    session.current = null;
    if (!current) {
      return null;
    }
    window.clearTimeout(current.timer);
    current.processor.onaudioprocess = null;
    current.source.disconnect();
    current.processor.disconnect();
    current.stream.getTracks().forEach((track) => track.stop());
    void current.context.close().catch(() => undefined);
    return current;
  }, []);

  const cancel = useCallback(() => {
    release();
    setLoudness(0);
    setState("idle");
  }, [release]);

  const stop = useCallback(async () => {
    const current = session.current;
    if (!current) {
      return;
    }
    const rate = current.context.sampleRate;
    release();
    setLoudness(0);
    const samples = resample(mergeChunks(current.chunks), rate, SPEECH_RATE);
    if (isSilent(samples)) {
      setState("idle");
      handlers.current.onProblem("Nothing was heard. Check the microphone and try again.");
      return;
    }
    setState("transcribing");
    try {
      const text = await speechTranscribe(toBase64(encodeWav(samples, SPEECH_RATE)));
      if (live.current) {
        if (text.trim()) {
          handlers.current.onText(text);
        } else {
          handlers.current.onProblem("No words were made out. Try again, closer to the microphone.");
        }
      }
    } catch (err) {
      if (live.current) {
        handlers.current.onProblem(problemText(err));
      }
    } finally {
      if (live.current) {
        setState("idle");
      }
    }
  }, [release]);

  const start = useCallback(async () => {
    setState("starting");
    try {
      // Better to learn there is no engine before the person has said anything.
      const status = await speechStatus();
      if (!status.ready) {
        setState("idle");
        handlers.current.onProblem(status.problem ?? "No speech engine is available. See Settings > Voice.");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (event) => {
        const data = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(data));
        setLoudness(level(data));
      };
      source.connect(processor);
      // A script processor only runs while it is connected on; it writes no sound.
      processor.connect(context.destination);
      session.current = {
        stream,
        context,
        processor,
        source,
        chunks,
        timer: window.setTimeout(() => void stop(), MAX_SECONDS * 1000),
      };
      if (!live.current) {
        release();
        return;
      }
      setState("recording");
    } catch (err) {
      release();
      setState("idle");
      handlers.current.onProblem(problemText(err));
    }
  }, [release, stop]);

  const toggle = useCallback(() => {
    if (stateRef.current === "idle") {
      void start();
    } else if (stateRef.current === "recording") {
      void stop();
    }
  }, [start, stop]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      release();
    };
  }, [release]);

  return { state, loudness, supported, toggle, cancel };
}
