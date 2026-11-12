import { useEffect, useRef, useState } from "react";
import {
  frameAt,
  horizontal,
  introEnabled,
  markIn,
  polyPoints,
  segmentShape,
  stampSegments,
  type Poly,
} from "./timeline";

const PIECES = [0, 1, 2] as const;
/** Where the segments land, found on screen every frame because the interface is still loading. */
function targets(width: number, height: number): [Poly, Poly, Poly] {
  const header = document.querySelector<HTMLElement>('[data-intro="header"]')?.getBoundingClientRect();
  const composer = document.querySelector<HTMLElement>('[data-intro="composer"]')?.getBoundingClientRect();
  const mark = document.querySelector<HTMLElement>('[data-intro="mark"]')?.getBoundingClientRect();
  const rule = horizontal(0, width, (header?.bottom ?? 61) - 0.5);
  const edge = composer
    ? horizontal(composer.left + 10, composer.right - 10, composer.top + 0.5)
    : horizontal(width / 2 - 30, width / 2 + 30, height / 2 + 40);
  const brand = mark
    ? markIn(mark)
    : markIn({ left: 29, top: 24, width: 16, height: 14 });
  return [rule, edge, brand];
}

/**
 * The opening of the app, "The Imprint" (see timeline.ts). It sits over the interface, which is
 * already rendered underneath, and removes itself when the segments have become the real header
 * rule, composer edge and brand mark. Skipped for people who prefer reduced motion.
 */
export function Imprint() {
  const [done, setDone] = useState(() => !introEnabled());
  const backdropRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(SVGPolylineElement | null)[]>([]);

  useEffect(() => {
    if (done) {
      document.documentElement.removeAttribute("data-intro-running");
      return;
    }
    const start = performance.now();
    let frameId = 0;
    const frame = (now: number) => {
      const elapsed = now - start;
      const state = frameAt(elapsed);
      if (state.done) {
        setDone(true);
        return;
      }
      const width = window.innerWidth;
      const height = window.innerHeight;
      const pieces = stampSegments(width / 2, height / 2);
      const [rule, edge, brand] = targets(width, height);
      const goals = [rule, edge, brand];
      PIECES.forEach((i) => {
        const line = lineRefs.current[i];
        if (!line) {
          return;
        }
        const travel = state.travel[i];
        line.setAttribute("points", polyPoints(segmentShape(pieces[i], goals[i], state.draw[i], travel)));
        line.style.strokeWidth = String(2.2 - travel * (i === 2 ? 0.6 : 1.2));
        // The header rule and the mark end as the real thing. The composer edge hands over to
        // the composer's own box and fades with it.
        line.style.stroke =
          i === 2
            ? "var(--cg-ink)"
            : `color-mix(in srgb, var(--cg-ink) ${((1 - travel) * 100).toFixed(1)}%, var(--cg-line-strong))`;
        line.style.opacity = i === 1 ? String(1 - Math.max(0, travel - 0.7) / 0.3) : "1";
        line.style.visibility = state.draw[i] > 0 ? "visible" : "hidden";
      });
      if (backdropRef.current) {
        backdropRef.current.style.opacity = String(state.backdrop);
      }
      frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(frameId);
  }, [done]);

  if (done) {
    return null;
  }
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[100]">
      <div ref={backdropRef} className="absolute inset-0 bg-cg-panel" />
      <svg className="absolute inset-0 h-full w-full overflow-visible" fill="none">
        {PIECES.map((i) => (
          <polyline
            key={i}
            ref={(element) => {
              lineRefs.current[i] = element;
            }}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ visibility: "hidden" }}
          />
        ))}
      </svg>
    </div>
  );
}
