/** How long the eyes stay shut for one blink. */
export const BLINK_MS = 150;
/** Gap between the two blinks of a double blink. */
export const DOUBLE_BLINK_GAP_MS = 130;

const MIN_WAIT_MS = 2400;
const SPREAD_MS = 4200;
const DOUBLE_BLINK_CHANCE = 0.2;

/** How long to wait before the next blink; `random` is a value in [0, 1). */
export function nextBlinkDelay(random: number): number {
  return MIN_WAIT_MS + Math.min(Math.max(random, 0), 0.9999) * SPREAD_MS;
}

/** Whether this blink is followed by a second quick one. */
export function isDoubleBlink(random: number): boolean {
  return random < DOUBLE_BLINK_CHANCE;
}
