/** How long the opening waves play before the app takes over. */
export const INTRO_MS = 1600;
/** The last stretch is a quick fade, so the cut to the app is hard but not a flash. */
export const INTRO_FADE_MS = 160;

/** Opacity of the opening waves `elapsed` ms after launch: 1 while playing, 0 once over. */
export function introOpacity(elapsed: number): number {
  if (elapsed >= INTRO_MS) {
    return 0;
  }
  const fadeStart = INTRO_MS - INTRO_FADE_MS;
  return elapsed <= fadeStart ? 1 : (INTRO_MS - elapsed) / INTRO_FADE_MS;
}
