import { describe, expect, it } from "vitest";
import { DEFAULT_DICTATION, MAX_SILENCE_MS, MIN_SILENCE_MS, normalizeDictation } from "./dictationPrefs";

describe("the dictation settings", () => {
  it("fills in what is missing", () => {
    expect(normalizeDictation(null)).toEqual(DEFAULT_DICTATION);
    expect(normalizeDictation({ autoStop: false })).toEqual({ ...DEFAULT_DICTATION, autoStop: false });
  });

  it("keeps the wait in range and on the slider's steps", () => {
    expect(normalizeDictation({ silenceMs: 10 }).silenceMs).toBe(MIN_SILENCE_MS);
    expect(normalizeDictation({ silenceMs: 99_999 }).silenceMs).toBe(MAX_SILENCE_MS);
    expect(normalizeDictation({ silenceMs: 1130 }).silenceMs).toBe(1250);
    expect(normalizeDictation({ silenceMs: "long", autoStop: "yes" })).toEqual(DEFAULT_DICTATION);
  });
});
