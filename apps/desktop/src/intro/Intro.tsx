import { useEffect, useRef, useState } from "react";
import { MARK_HEIGHT, MARK_STROKE } from "./BrandMark";
import { layout, pathD, type Placement } from "./glyphs";
import { introEnabled, lerpPlacement, settleAt, strokeProgress, wordPlacement } from "./timeline";

const WORD = layout();
/** Line width of the letters on screen; the first A thickens to the logo's as it lands. */
const LETTER_STROKE = 1.2;
const FALLBACK_MARK = { left: 29, top: 20, height: MARK_HEIGHT };

/** Where the first A lands: the real logo in the header, measured on every frame. */
function markPlacement(): Placement {
  const rect = document.querySelector<HTMLElement>('[data-intro="mark"]')?.getBoundingClientRect() ?? FALLBACK_MARK;
  return { ox: rect.left, oy: rect.top, s: rect.height / 100 };
}

/**
 * The opening of the app (see timeline.ts): ATARAXIA is drawn, and its first A becomes the logo.
 * It sits over the interface, already rendered underneath, and removes itself at the end.
 * Skipped for people who prefer reduced motion.
 */
export function Intro() {
  const [done, setDone] = useState(() => !introEnabled());
  const backdropRef = useRef<HTMLDivElement>(null);
  const paths = useRef<(SVGPathElement | null)[][]>([]);

  useEffect(() => {
    if (done) {
      document.documentElement.removeAttribute("data-intro-running");
      return;
    }
    const start = performance.now();
    let frameId = 0;
    const frame = (now: number) => {
      const elapsed = now - start;
      const settle = settleAt(elapsed);
      if (settle.done) {
        setDone(true);
        return;
      }
      const home = wordPlacement(window.innerWidth, window.innerHeight);
      WORD.items.forEach((letter) => {
        const lead = letter.index === 0;
        // The first A is the only letter that moves on its own; the others keep their place.
        const place = lead ? lerpPlacement(home, markPlacement(), settle.travel) : home;
        const dx = lead ? 0 : letter.x;
        letter.glyph.strokes.forEach((cmds, k) => {
          const element = paths.current[letter.index]?.[k];
          if (!element) {
            return;
          }
          const progress = strokeProgress(elapsed, letter.index, k, letter.glyph.strokes.length);
          element.setAttribute("d", pathD(cmds, place, dx));
          element.setAttribute("stroke-dashoffset", String(1 - progress));
          element.style.visibility = progress > 0 ? "visible" : "hidden";
          element.style.opacity = lead ? "1" : String(1 - settle.fade);
          element.setAttribute("stroke-width", String(LETTER_STROKE + (lead ? (MARK_STROKE - LETTER_STROKE) * settle.travel : 0)));
        });
      });
      if (backdropRef.current) {
        backdropRef.current.style.opacity = String(settle.backdrop);
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
      <svg className="absolute inset-0 h-full w-full overflow-visible text-cg-ink" fill="none">
        {WORD.items.map((letter) =>
          letter.glyph.strokes.map((_, k) => (
            <path
              key={`${letter.index}-${k}`}
              ref={(element) => {
                (paths.current[letter.index] ??= [])[k] = element;
              }}
              pathLength={1}
              stroke="currentColor"
              strokeDasharray="1 2"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={LETTER_STROKE}
              style={{ visibility: "hidden" }}
            />
          )),
        )}
      </svg>
    </div>
  );
}
