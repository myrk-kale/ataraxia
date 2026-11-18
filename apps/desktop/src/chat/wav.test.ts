import { describe, expect, it } from "vitest";
import { appendDictation, encodeWav, isSilent, level, mergeChunks, resample, SPEECH_RATE, toBase64 } from "./wav";

describe("preparing a recording for Whisper", () => {
  it("joins the chunks in order", () => {
    expect([...mergeChunks([Float32Array.of(1, 2), Float32Array.of(), Float32Array.of(3)])]).toEqual([1, 2, 3]);
  });

  it("brings a 48 kHz recording down to 16 kHz without changing its length in time", () => {
    const second = new Float32Array(48000).fill(0.5);
    const out = resample(second, 48000, SPEECH_RATE);
    expect(out.length).toBe(16000);
    expect(out[100]).toBeCloseTo(0.5, 5);
    expect(resample(second, 16000, 16000)).toBe(second);
    expect(resample(new Float32Array(0), 44100, 16000)).toHaveLength(0);
  });

  it("averages what it skips instead of dropping it", () => {
    const out = resample(Float32Array.of(0, 1, 0, 1, 0, 1), 6, 2);
    expect([...out].map((value) => Math.round(value * 100) / 100)).toEqual([0.33, 0.67]);
  });

  it("writes a 16-bit mono WAV that says what it holds", () => {
    const wav = encodeWav(Float32Array.of(0, 1, -1, 0.5), 16000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(8);
    expect(wav.length).toBe(44 + 8);
    expect(view.getInt16(46, true)).toBe(0x7fff);
    expect(view.getInt16(48, true)).toBe(-0x8000);
  });

  it("tells room noise from speech", () => {
    expect(isSilent(new Float32Array(1000).fill(0.001))).toBe(true);
    expect(isSilent(new Float32Array(0))).toBe(true);
    expect(isSilent(new Float32Array(1000).fill(0.2))).toBe(false);
    expect(level(Float32Array.of(1, -1))).toBe(1);
  });

  it("encodes bytes as base64, large recordings included", () => {
    expect(toBase64(Uint8Array.of(104, 105))).toBe("aGk=");
    const big = new Uint8Array(200_000).fill(65);
    expect(atob(toBase64(big))).toHaveLength(200_000);
  });

  it("adds dictated text after what was typed", () => {
    expect(appendDictation("", "  hello ")).toBe("hello");
    expect(appendDictation("fix this  \n", "and that")).toBe("fix this and that");
    expect(appendDictation("keep", "   ")).toBe("keep");
  });
});
