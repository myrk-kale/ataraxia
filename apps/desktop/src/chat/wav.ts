/** Whisper listens at 16 kHz, one channel. */
export const SPEECH_RATE = 16000;

export function mergeChunks(chunks: readonly Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(length);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.length;
  }
  return merged;
}

/** Linear resampling, enough for speech: it averages the source samples each output sample spans. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) {
    return input;
  }
  const ratio = from / to;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = i * ratio;
    const end = Math.min(input.length, (i + 1) * ratio);
    let first = Math.floor(start);
    let sum = 0;
    let count = 0;
    // Down-sampling averages what it skips over, which keeps the high end from folding back.
    for (; first < end || count === 0; first += 1) {
      sum += input[Math.min(first, input.length - 1)] ?? 0;
      count += 1;
      if (first >= input.length - 1) {
        break;
      }
    }
    out[i] = sum / count;
  }
  return out;
}

/** The loudness of a stretch of samples, 0 to 1. */
export function level(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/** Nothing but room noise: not worth sending to a model, which would make words up from it. */
export function isSilent(samples: Float32Array): boolean {
  return samples.length === 0 || level(samples) < 0.004;
}

/** 16-bit PCM in a WAV container (mono). */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
  });
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** Puts dictated text after what is already in the field, with one space between and no more. */
export function appendDictation(current: string, dictated: string): string {
  const text = dictated.trim();
  if (!text) {
    return current;
  }
  return current.trim() === "" ? text : `${current.replace(/\s+$/, "")} ${text}`;
}
