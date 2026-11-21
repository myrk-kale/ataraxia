import { describe, expect, it } from "vitest";
import { createHearing, GIVE_UP_AFTER_MS, STOP_AFTER_SILENCE_MS } from "./vad";

const FRAME = 85;

/** Feeds `ms` of sound at `level`, and returns what the last stretch said. */
function feed(hearing: ReturnType<typeof createHearing>, level: number, ms: number) {
  let last = hearing.push(level, 0);
  for (let at = 0; at < ms; at += FRAME) {
    last = hearing.push(level, FRAME);
  }
  return last;
}

describe("knowing when the person has finished speaking", () => {
  it("ends the recording after the silence that follows speech, and not before", () => {
    const hearing = createHearing();
    expect(feed(hearing, 0.002, 400).verdict).toBe("listening");
    expect(feed(hearing, 0.1, 1500).spoke).toBe(true);
    expect(feed(hearing, 0.002, STOP_AFTER_SILENCE_MS - FRAME * 2).verdict).toBe("listening");
    expect(feed(hearing, 0.002, FRAME * 3).verdict).toBe("end-of-speech");
  });

  it("keeps going through a short pause between words", () => {
    const hearing = createHearing();
    feed(hearing, 0.1, 800);
    expect(feed(hearing, 0.002, 400).verdict).toBe("listening");
    const again = feed(hearing, 0.1, 300);
    expect(again.silentMs).toBe(0);
    expect(again.verdict).toBe("listening");
  });

  it("does not take a click for speech", () => {
    const hearing = createHearing();
    feed(hearing, 0.002, 300);
    feed(hearing, 0.2, FRAME);
    const after = feed(hearing, 0.002, STOP_AFTER_SILENCE_MS + 500);
    expect(after.spoke).toBe(false);
    expect(after.verdict).toBe("listening");
  });

  it("gives up when nothing is said for a long while", () => {
    const hearing = createHearing();
    expect(feed(hearing, 0.002, GIVE_UP_AFTER_MS - 500).verdict).toBe("listening");
    expect(feed(hearing, 0.002, 1000).verdict).toBe("no-speech");
  });

  it("follows the noise of the room: a steady hum is not speech, a voice over it is", () => {
    const hearing = createHearing();
    // A noisy room, louder than the fixed floor, but steady.
    expect(feed(hearing, 0.02, 1500).spoke).toBe(false);
    expect(feed(hearing, 0.15, 600).speaking).toBe(true);
    expect(feed(hearing, 0.02, 600).speaking).toBe(false);
  });

  it("stops after the quiet it was told to wait for", () => {
    const hearing = createHearing({ stopAfterMs: 3000 });
    feed(hearing, 0.1, 800);
    expect(feed(hearing, 0.002, 2500).verdict).toBe("listening");
    expect(feed(hearing, 0.002, 800).verdict).toBe("end-of-speech");
  });

  it("never ends by itself when it is told not to", () => {
    const hearing = createHearing({ stopAfterMs: Infinity, giveUpAfterMs: Infinity });
    expect(feed(hearing, 0.002, GIVE_UP_AFTER_MS * 3).verdict).toBe("listening");
    feed(hearing, 0.1, 800);
    expect(feed(hearing, 0.002, 60_000).verdict).toBe("listening");
  });
});
