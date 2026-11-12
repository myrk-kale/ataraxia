/** The logo: the name in Avenir Next Ultra Light with wide tracking. */
export const WORDMARK = {
  text: "Ataraxia",
  fontWeight: 200,
  letterSpacing: "0.28em",
} as const;

/**
 * Avenir Next ships with macOS, which is what the desktop app targets; elsewhere the stack falls
 * back to the closest light geometric sans. The trailing negative margin cancels the tracking
 * that CSS adds after the last letter, so the word sits flush against what follows.
 */
export function Wordmark() {
  return (
    <span
      className="flex-none text-[16px] leading-none text-cg-ink select-none"
      style={{
        fontFamily: '"Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif',
        fontWeight: WORDMARK.fontWeight,
        letterSpacing: WORDMARK.letterSpacing,
        marginRight: `calc(0.5rem - ${WORDMARK.letterSpacing})`,
      }}
    >
      {WORDMARK.text}
    </span>
  );
}
