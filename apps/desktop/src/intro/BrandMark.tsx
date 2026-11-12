import { CAP, GLYPHS, pathD } from "./glyphs";

export const MARK_HEIGHT = 20;
/** Line width on screen, in px; the opening draws the first A with the same one. */
export const MARK_STROKE = 1.6;
const SCALE = MARK_HEIGHT / CAP;
const A = GLYPHS.A;

/** The logo in the header: the A of ATARAXIA, and where the opening animation lands. */
export function BrandMark() {
  return (
    <svg
      aria-hidden="true"
      className="flex-none overflow-visible text-cg-ink"
      data-intro="mark"
      fill="none"
      height={MARK_HEIGHT}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={MARK_STROKE}
      width={A.width * SCALE}
    >
      <path d={pathD(A.strokes[0], { ox: 0, oy: 0, s: SCALE })} />
    </svg>
  );
}
