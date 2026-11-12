import { useEffect, useState } from "react";
import { AXOLOTL_ART, AXOLOTL_CLOSED_ART } from "./axolotlArt";
import { BLINK_MS, DOUBLE_BLINK_GAP_MS, isDoubleBlink, nextBlinkDelay } from "./blink";

/** True while the eyes should be shut. It stays false for people who prefer reduced motion. */
function useBlink(): boolean {
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    let timer = 0;
    const open = (then: () => void, wait: number) => {
      timer = window.setTimeout(() => {
        setClosed(false);
        then();
      }, wait);
    };
    const shut = (then: () => void) => {
      setClosed(true);
      open(then, BLINK_MS);
    };
    const schedule = () => {
      timer = window.setTimeout(() => {
        shut(() => {
          if (isDoubleBlink(Math.random())) {
            timer = window.setTimeout(() => shut(schedule), DOUBLE_BLINK_GAP_MS);
          } else {
            schedule();
          }
        });
      }, nextBlinkDelay(Math.random()));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  return closed;
}

/**
 * The braille axolotl: it floats and blinks now and then. Decorative, so it is hidden from
 * assistive technology; clicks on it fall through to the wave field behind.
 */
export function Axolotl() {
  const closed = useBlink();
  return (
    <div aria-hidden="true" className="flex justify-center" data-wave-surface>
      <pre
        className="cg-axolotl m-0 font-mono text-[clamp(6px,0.62vw,9px)] leading-[0.94] whitespace-pre text-cg-ink select-none"
        data-eyes={closed ? "closed" : "open"}
        data-wave-surface
      >
        {closed ? AXOLOTL_CLOSED_ART : AXOLOTL_ART}
      </pre>
    </div>
  );
}
