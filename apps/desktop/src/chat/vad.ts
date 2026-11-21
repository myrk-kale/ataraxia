/** How long the person is quiet, after having spoken, before the recording ends by itself (the default; it is a setting). */
export const STOP_AFTER_SILENCE_MS = 1500;
/** A shorter pause than that already closes a phrase: its text is written while they go on. */
export const PHRASE_PAUSE_MS = 450;
/** Nothing said for this long since the microphone opened: they changed their mind. */
export const GIVE_UP_AFTER_MS = 8000;
/** Less speech than this is a click or a cough, not something said. */
const MIN_SPEECH_MS = 200;
/** The quietest a room is taken to be; below this level nobody is speaking. */
const FLOOR_LEVEL = 0.008;
/** The loudest a room's own noise is taken to be. */
const NOISE_CAP = 0.02;

export type Hearing = {
  /** The last stretch of sound was speech. */
  speaking: boolean;
  /** Something has been said since the microphone opened. */
  spoke: boolean;
  /** Quiet for this long, in ms; 0 while speaking. */
  silentMs: number;
  /** `end-of-speech`: they spoke and have been quiet long enough. `no-speech`: they never started. */
  verdict: "listening" | "end-of-speech" | "no-speech";
};

/**
 * Tells speech from the quiet between words, one stretch of the microphone at a time. The bar for
 * "speech" follows the room: it is a few times the noise the room makes when nobody talks, so a
 * fan or a noisy street does not keep the recording open, and a quiet voice is not missed.
 * `Infinity` for `stopAfterMs` and `giveUpAfterMs` never ends the recording: only the person does.
 */
export function createHearing({
  stopAfterMs = STOP_AFTER_SILENCE_MS,
  giveUpAfterMs = GIVE_UP_AFTER_MS,
}: { stopAfterMs?: number; giveUpAfterMs?: number } = {}) {
  let noise: number | null = null;
  let speechMs = 0;
  let silentMs = 0;
  let elapsedMs = 0;

  return {
    /** `level` is the loudness (0 to 1) of a stretch that lasted `ms`. */
    push(level: number, ms: number): Hearing {
      elapsedMs += ms;
      // The first stretch is taken as the room; the cap keeps a person who starts talking at once
      // from setting a bar their own voice cannot clear.
      noise ??= level;
      const bar = Math.max(FLOOR_LEVEL, Math.min(noise, NOISE_CAP) * 3);
      const speaking = level >= bar;
      if (speaking) {
        speechMs += ms;
        silentMs = 0;
      } else {
        // The room's own noise is learned only from the quiet: speech must not raise the bar.
        noise = level < noise ? level : noise + (level - noise) * 0.1;
        silentMs += ms;
      }
      const spoke = speechMs >= MIN_SPEECH_MS;
      let verdict: Hearing["verdict"] = "listening";
      if (spoke && silentMs >= stopAfterMs) {
        verdict = "end-of-speech";
      } else if (!spoke && elapsedMs >= giveUpAfterMs) {
        verdict = "no-speech";
      }
      return { speaking, spoke, silentMs, verdict };
    },
  };
}
