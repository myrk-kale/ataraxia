/**
 * A few small sounds for the interface, made with the Web Audio API so no file is shipped. There
 * are only two: a tick for the moments that matter (changing space, choosing a model) and a chime
 * for the agent asking for approval. Presses in general are silent. They are on by default and
 * can be turned off in Settings; nothing plays before the person has touched the app, because the
 * browser does not allow it.
 */
import { useSyncExternalStore } from "react";

export type SoundName = "tick" | "alert";

export type SoundSettings = { enabled: boolean; volume: number };

const KEY = "ataraxia.sound";
export const DEFAULT_SOUND: SoundSettings = { enabled: true, volume: 0.6 };

/** Settings as stored, which may be missing or hand-edited, made whole and in range. */
export function normalizeSound(value: unknown): SoundSettings {
  const stored = value && typeof value === "object" ? (value as Partial<SoundSettings>) : {};
  const volume = typeof stored.volume === "number" && Number.isFinite(stored.volume) ? stored.volume : DEFAULT_SOUND.volume;
  return {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULT_SOUND.enabled,
    volume: Math.min(1, Math.max(0, Math.round(volume * 20) / 20)),
  };
}

function read(): SoundSettings {
  try {
    const text = window.localStorage.getItem(KEY);
    return normalizeSound(text ? JSON.parse(text) : null);
  } catch {
    return DEFAULT_SOUND;
  }
}

let settings: SoundSettings = read();
const listeners = new Set<() => void>();

export function setSound(change: Partial<SoundSettings>) {
  settings = normalizeSound({ ...settings, ...change });
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not remembering the choice is harmless.
  }
  listeners.forEach((listener) => listener());
}

export function useSound(): SoundSettings & { set: (change: Partial<SoundSettings>) => void } {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => settings,
    () => DEFAULT_SOUND,
  );
  return { ...current, set: setSound };
}

let context: AudioContext | null = null;
let noise: AudioBuffer | null = null;
const lastPlayed = new Map<SoundName, number>();
/** The same sound twice within this many milliseconds is one sound. */
const MIN_GAP = 35;

/** Audio may only start once the person has pressed something; before that nothing is made. */
let touched = false;

function audio(): AudioContext | null {
  if (context) {
    return context;
  }
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if (!touched && !activation?.hasBeenActive) {
    return null;
  }
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    return null;
  }
  try {
    context = new Ctor();
  } catch {
    return null;
  }
  return context;
}

function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (!noise) {
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
  }
  return noise;
}

/** A burst of noise through a band-pass filter: the "click" of a key. */
function click(ctx: AudioContext, at: number, volume: number, frequency: number, length: number) {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = frequency;
  filter.Q.value = 1.1;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(at);
  source.stop(at + length + 0.01);
}

/** A short sine tone that glides from one pitch to another: the body of the sound. */
function tone(ctx: AudioContext, at: number, volume: number, from: number, to: number, length: number) {
  const oscillator = ctx.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(from, at);
  oscillator.frequency.exponentialRampToValueAtTime(to, at + length);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + length + 0.01);
}

const VOICES: Record<SoundName, (ctx: AudioContext, at: number, v: number) => void> = {
  // A light key: a little noise on top, a short tone under it.
  tick: (ctx, at, v) => {
    click(ctx, at, 0.4 * v, 3200, 0.013);
    tone(ctx, at, 0.2 * v, 1100, 760, 0.04);
  },
  alert: (ctx, at, v) => {
    tone(ctx, at, 0.2 * v, 660, 660, 0.09);
    tone(ctx, at + 0.11, 0.2 * v, 880, 880, 0.12);
  },
};

/** Plays a sound, unless sounds are off or the browser has not allowed audio yet. */
export function play(name: SoundName, override?: Partial<SoundSettings>) {
  const { enabled, volume } = { ...settings, ...override };
  if (!enabled || volume <= 0 || typeof window === "undefined") {
    return;
  }
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < MIN_GAP) {
    return;
  }
  lastPlayed.set(name, now);
  const ctx = audio();
  if (!ctx) {
    return;
  }
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => undefined);
  }
  try {
    VOICES[name](ctx, ctx.currentTime + 0.005, volume);
  } catch {
    // A sound that cannot be made is simply not heard.
  }
}

/** Notes that the person has touched the app, after which the browser lets audio start. */
export function watchForTouch(): () => void {
  const touch = () => {
    touched = true;
  };
  document.addEventListener("pointerdown", touch, true);
  document.addEventListener("keydown", touch, true);
  return () => {
    document.removeEventListener("pointerdown", touch, true);
    document.removeEventListener("keydown", touch, true);
  };
}
