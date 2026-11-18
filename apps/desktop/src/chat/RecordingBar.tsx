import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DictationState, Listening } from "./useDictation";

/** How many bars of sound are shown: about three seconds. */
const BARS = 32;

export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The part of a long text that fits: its end, which is where the person is. */
export function tail(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `…${flat.slice(flat.length - max).replace(/^\S*\s/, "")}`;
}

function label(state: DictationState, listening: Listening): string {
  if (state === "starting") {
    return "Opening the microphone…";
  }
  if (state === "transcribing") {
    return "Writing what you said…";
  }
  if (listening === "hearing") {
    return "Hearing you";
  }
  if (listening === "pausing") {
    return "Paused. It stops if you stay quiet";
  }
  return "Listening. Say something";
}

/**
 * What the message field shows while dictating: that the microphone is open, the sound it is
 * getting, how long it has been, the words as far as they are made out, and how near the pause is
 * to ending the recording. Nothing here is a control: the button and Esc are.
 */
export function RecordingBar({
  state,
  loudness,
  listening,
  silence,
  partial,
}: {
  state: DictationState;
  loudness: number;
  listening: Listening;
  /** 0 to 1: how far the quiet after speech is towards ending the recording. */
  silence: number;
  partial: string;
}) {
  const recording = state === "recording";
  const [sound, setSound] = useState<number[]>(() => Array.from({ length: BARS }, () => 0));
  const [seconds, setSeconds] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (recording) {
      setSound((before) => [...before.slice(1), loudness]);
    }
  }, [loudness, recording]);

  useEffect(() => {
    if (!recording) {
      return;
    }
    startedAt.current = Date.now();
    setSeconds(0);
    setSound(Array.from({ length: BARS }, () => 0));
    const timer = window.setInterval(() => setSeconds((Date.now() - startedAt.current) / 1000), 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  if (state === "idle") {
    return null;
  }
  const busy = state === "starting" || state === "transcribing";
  const words = tail(partial);
  return (
    <div className="mb-2.5 overflow-hidden rounded-cg-md border border-cg-line bg-cg-panel" data-testid="recording-bar">
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="flex flex-none items-center gap-2 text-small font-medium text-cg-del-fg">
          {busy ? (
            <Loader2 aria-hidden="true" className="animate-spin" size={13} />
          ) : (
            <span aria-hidden="true" className="cg-rec-dot h-2 w-2 rounded-full bg-cg-del-fg" />
          )}
          <span className="tabular-nums">{recording ? clock(seconds) : "…"}</span>
        </span>
        <div aria-hidden="true" className="flex h-5 min-w-0 flex-1 items-center gap-[2px]">
          {sound.map((value, index) => (
            <span
              key={index}
              className={`w-[3px] flex-none rounded-full transition-[height] duration-100 ${
                recording ? "bg-cg-del-fg" : "bg-cg-line-strong"
              }`}
              style={{
                height: `${Math.round(Math.max(0.14, Math.min(1, value * 5)) * 100)}%`,
                opacity: 0.35 + (index / BARS) * 0.65,
              }}
            />
          ))}
        </div>
        <span className="flex-none text-small text-cg-muted-strong" role="status">
          {label(state, listening)}
        </span>
      </div>
      {words ? (
        <p aria-live="off" className="border-t border-cg-line px-3 py-1.5 text-small leading-5 text-cg-muted-strong">
          {words}
        </p>
      ) : null}
      {recording ? (
        <div aria-hidden="true" className="h-0.5 bg-cg-line">
          <div className="h-full bg-cg-del-fg transition-[width] duration-100" style={{ width: `${Math.round(silence * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}
