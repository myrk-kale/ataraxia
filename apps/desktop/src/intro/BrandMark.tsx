import { MARK_BOX, MARK_POINTS } from "./timeline";

/** The Λ of the brand: the app's icon in the header, and where the opening animation lands. */
export function BrandMark() {
  return (
    <svg
      aria-hidden="true"
      className="flex-none text-cg-ink"
      data-intro="mark"
      fill="none"
      height={MARK_BOX.height}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.6}
      viewBox={`0 0 ${MARK_BOX.width} ${MARK_BOX.height}`}
      width={MARK_BOX.width}
    >
      <polyline points={MARK_POINTS.map(([x, y]) => `${x},${y}`).join(" ")} />
    </svg>
  );
}
