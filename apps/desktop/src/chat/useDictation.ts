import { useCallback, useEffect, useRef, useState } from "react";
import { speechStatus, speechTranscribe, speechWarmup } from "../lib/speech";
import { readDictationPrefs } from "./dictationPrefs";
import { createHearing, PHRASE_PAUSE_MS } from "./vad";
import { encodeWav, isSilent, level, mergeChunks, resample, SPEECH_RATE, toBase64 } from "./wav";

export type DictationState = "idle" | "starting" | "recording" | "transcribing";
/** What the microphone is making of the room: nobody yet, someone speaking, or a pause. */
export type Listening = "waiting" | "hearing" | "pausing";

/** A dictation longer than this stops by itself: it is a message, and the engine has a limit too. */
const MAX_SECONDS = 150;
/** Recording until the button is pressed again is not cut at that, only at this: phrases are written as they close. */
const MAX_MANUAL_SECONDS = 30 * 60;
/** How often the words not yet written are tried, to show them while the person goes on. */
const PREVIEW_EVERY_MS = 1000;
/** A phrase this long is written even with no pause in it: the engine listens to 30 s at a time. */
const MAX_PHRASE_SECONDS = 20;
/** Less speech than this in a stretch is not worth listening to. */
const MIN_PHRASE_MS = 200;
/** A preview of less than this has too little to go on. */
const MIN_PREVIEW_SECONDS = 0.5;
/** Quiet kept ahead of the words, so the first sound is not cut. */
const LEAD_SECONDS = 0.4;

function problemText(err: unknown): string {
  if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
    return "The microphone is blocked. Allow Ataraxia to use it in the system settings, then try again.";
  }
  if (err instanceof DOMException && err.name === "NotFoundError") {
    return "No microphone was found.";
  }
  return err instanceof Error ? err.message : String(err);
}

type Session = {
  stream: MediaStream;
  context: AudioContext;
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  rate: number;
  hearing: ReturnType<typeof createHearing>;
  /** The quiet that ends the recording, in ms; `Infinity` when only the button ends it. */
  stopAfterMs: number;
  /** The engine can write while the person speaks (a command of their own cannot). */
  streaming: boolean;
  /** What was recorded since the last phrase was closed. */
  pending: Float32Array[];
  pendingSamples: number;
  pendingSpeechMs: number;
  /** Counts the phrases closed, so a preview of one that is already written is let go. */
  phrase: number;
  previewing: boolean;
  /** Phrases handed over to be written. */
  closed: number;
  timers: number[];
};

/** The recording as the engine wants it, or `null` when it is only quiet. */
async function listen(chunks: readonly Float32Array[], rate: number, quick: boolean): Promise<string | null> {
  const samples = resample(mergeChunks(chunks), rate, SPEECH_RATE);
  if (isSilent(samples)) {
    return null;
  }
  return speechTranscribe(toBase64(encodeWav(samples, SPEECH_RATE)), quick);
}

/**
 * Dictation for the message field. It records from the microphone and writes what is said with the
 * Whisper engine on this computer; nothing leaves the machine.
 *
 * It follows the person: each phrase is written as soon as they pause after it (`onText` receives
 * it then, and it stays), what is still being said is shown as `partial` while they go on, and the
 * recording ends by itself once they have been quiet for as long as the settings say, or, when
 * that is turned off, only when they press the button again. `toggle` starts and stops, and
 * `cancel` stops and drops what has not been written yet.
 */
export function useDictation({
  onText,
  onProblem,
  onNeedsModel,
}: {
  onText: (text: string) => void;
  onProblem: (message: string) => void;
  /** The built-in engine has no model yet: the person is to be asked before it is downloaded. */
  onNeedsModel: (megabytes: number) => void;
}) {
  const [state, setState] = useState<DictationState>("idle");
  const [loudness, setLoudness] = useState(0);
  const [listening, setListening] = useState<Listening>("waiting");
  /** 0 to 1: how far the quiet after speech is towards ending the recording. */
  const [silence, setSilence] = useState(0);
  const [partial, setPartial] = useState("");
  /** The recording on screen ends by itself in a quiet moment (what the settings said when it began). */
  const [autoStop, setAutoStop] = useState(true);
  const session = useRef<Session | null>(null);
  /** Changes whenever a dictation is over or thrown away, so what is still in flight is let go. */
  const generation = useRef(0);
  /** What is being listened to, one piece at a time and in order. */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const written = useRef(false);
  const live = useRef(true);
  const handlers = useRef({ onText, onProblem, onNeedsModel });
  handlers.current = { onText, onProblem, onNeedsModel };
  const stateRef = useRef(state);
  stateRef.current = state;

  const supported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

  const release = useCallback(() => {
    const current = session.current;
    session.current = null;
    if (!current) {
      return null;
    }
    current.timers.forEach((timer) => window.clearTimeout(timer));
    current.processor.onaudioprocess = null;
    current.source.disconnect();
    current.processor.disconnect();
    current.stream.getTracks().forEach((track) => track.stop());
    void current.context.close().catch(() => undefined);
    return current;
  }, []);

  const reset = useCallback(() => {
    setLoudness(0);
    setListening("waiting");
    setSilence(0);
    setPartial("");
  }, []);

  const cancel = useCallback(() => {
    generation.current += 1;
    release();
    reset();
    setState("idle");
  }, [release, reset]);

  /** Hands a closed phrase over to be written, after the ones before it. */
  const write = useCallback((chunks: Float32Array[], rate: number, mine: number) => {
    queue.current = queue.current.then(async () => {
      if (mine !== generation.current) {
        return;
      }
      try {
        const text = await listen(chunks, rate, false);
        if (mine !== generation.current) {
          return;
        }
        if (text?.trim()) {
          written.current = true;
          handlers.current.onText(text);
        }
        setPartial("");
      } catch (err) {
        if (mine === generation.current) {
          generation.current += 1;
          release();
          reset();
          setState("idle");
          handlers.current.onProblem(problemText(err));
        }
      }
    });
  }, [release, reset]);

  /** Tries the words not yet written, for the person to see while they speak. */
  const preview = useCallback((current: Session) => {
    if (
      !current.streaming ||
      current.previewing ||
      current.pendingSpeechMs < MIN_PHRASE_MS ||
      current.pendingSamples < MIN_PREVIEW_SECONDS * current.rate
    ) {
      return;
    }
    current.previewing = true;
    const mine = generation.current;
    const phrase = current.phrase;
    const chunks = [...current.pending];
    queue.current = queue.current.then(async () => {
      try {
        if (mine !== generation.current || phrase !== current.phrase) {
          return;
        }
        const text = await listen(chunks, current.rate, true);
        if (mine === generation.current && phrase === current.phrase) {
          setPartial(text?.trim() ?? "");
        }
      } catch {
        // A preview that fails is not worth a warning: the phrase will say if it cannot be written.
      } finally {
        current.previewing = false;
      }
    });
  }, []);

  const stop = useCallback(async () => {
    const current = session.current;
    if (!current) {
      return;
    }
    const mine = generation.current;
    release();
    setLoudness(0);
    setListening("waiting");
    setSilence(0);
    // What was said since the last phrase was written. With nothing written yet, any sound at all
    // goes too, so a quiet voice that the pause detector missed still has its chance.
    const sounded = current.closed === 0 && !isSilent(mergeChunks(current.pending));
    const tail = current.pendingSpeechMs >= MIN_PHRASE_MS || sounded ? current.pending : null;
    if (!tail && current.closed === 0) {
      setState("idle");
      setPartial("");
      handlers.current.onProblem("Nothing was heard. Check the microphone and try again.");
      return;
    }
    setState("transcribing");
    let nothingHeard = false;
    let failed = false;
    if (tail) {
      queue.current = queue.current.then(async () => {
        if (mine !== generation.current) {
          return;
        }
        try {
          const text = await listen(tail, current.rate, false);
          if (mine !== generation.current) {
            return;
          }
          if (text === null) {
            nothingHeard = true;
          } else if (text.trim()) {
            written.current = true;
            handlers.current.onText(text);
          }
        } catch (err) {
          if (mine === generation.current) {
            failed = true;
            handlers.current.onProblem(problemText(err));
          }
        }
      });
    }
    await queue.current;
    if (mine !== generation.current) {
      return;
    }
    setPartial("");
    setState("idle");
    if (!written.current && !failed) {
      handlers.current.onProblem(
        nothingHeard
          ? "Nothing was heard. Check the microphone and try again."
          : "No words were made out. Try again, closer to the microphone.",
      );
    }
  }, [release]);

  const start = useCallback(async () => {
    setState("starting");
    try {
      // Better to learn there is no engine before the person has said anything.
      const status = await speechStatus();
      if (status.needs_model) {
        setState("idle");
        handlers.current.onNeedsModel(status.model_megabytes);
        return;
      }
      if (!status.ready) {
        setState("idle");
        handlers.current.onProblem(status.problem ?? "Dictation is not available. See Settings > Voice.");
        return;
      }
      // The model loads while the microphone opens, not after the first words.
      void speechWarmup().catch(() => undefined);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (!live.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const prefs = readDictationPrefs();
      const stopAfterMs = prefs.autoStop ? prefs.silenceMs : Infinity;
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const current: Session = {
        stream,
        context,
        processor,
        source,
        rate: context.sampleRate,
        hearing: createHearing({ stopAfterMs, giveUpAfterMs: stopAfterMs === Infinity ? Infinity : undefined }),
        stopAfterMs,
        streaming: status.streaming,
        pending: [],
        pendingSamples: 0,
        pendingSpeechMs: 0,
        phrase: 0,
        previewing: false,
        closed: 0,
        timers: [],
      };
      written.current = false;
      generation.current += 1;
      const mine = generation.current;
      processor.onaudioprocess = (event) => {
        if (session.current !== current || mine !== generation.current) {
          return;
        }
        const frame = new Float32Array(event.inputBuffer.getChannelData(0));
        const loud = level(frame);
        const ms = (frame.length / current.rate) * 1000;
        const heard = current.hearing.push(loud, ms);
        current.pending.push(frame);
        current.pendingSamples += frame.length;
        if (heard.speaking) {
          current.pendingSpeechMs += ms;
        }
        // Before anything is said, only a little quiet is kept ahead of it.
        while (current.pendingSpeechMs === 0 && current.pendingSamples > LEAD_SECONDS * current.rate && current.pending.length > 1) {
          current.pendingSamples -= current.pending.shift()?.length ?? 0;
        }
        setLoudness(loud);
        setListening(heard.speaking ? "hearing" : heard.spoke ? "pausing" : "waiting");
        setSilence(heard.spoke && Number.isFinite(current.stopAfterMs) ? Math.min(1, heard.silentMs / current.stopAfterMs) : 0);
        if (heard.verdict !== "listening") {
          void stop();
          return;
        }
        if (
          current.streaming &&
          current.pendingSpeechMs >= MIN_PHRASE_MS &&
          (heard.silentMs >= PHRASE_PAUSE_MS || current.pendingSamples > MAX_PHRASE_SECONDS * current.rate)
        ) {
          const chunks = current.pending;
          current.pending = [];
          current.pendingSamples = 0;
          current.pendingSpeechMs = 0;
          current.phrase += 1;
          current.closed += 1;
          write(chunks, current.rate, mine);
        }
      };
      source.connect(processor);
      // A script processor only runs while it is connected on; it writes no sound.
      processor.connect(context.destination);
      current.timers.push(
        window.setTimeout(
          () => void stop(),
          (prefs.autoStop || !status.streaming ? MAX_SECONDS : MAX_MANUAL_SECONDS) * 1000,
        ),
        window.setInterval(() => preview(current), PREVIEW_EVERY_MS),
      );
      session.current = current;
      setAutoStop(prefs.autoStop);
      setPartial("");
      setState("recording");
    } catch (err) {
      release();
      setState("idle");
      handlers.current.onProblem(problemText(err));
    }
  }, [preview, release, stop, write]);

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
      generation.current += 1;
      release();
    };
  }, [release]);

  return { state, loudness, listening, silence, partial, autoStop, supported, toggle, cancel };
}
