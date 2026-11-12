import { useEffect, useRef } from "react";
import type { PieceModule } from "../vendor/ascii-magic/player.js";

/** How the picture is drawn: filled squares, from the ascii-magic looks. */
const LOOK = "squares";
/** How present the art is once it has faded in. */
const STRENGTH = 0.6;

/**
 * Animated ASCII art for the opening of the app. It covers its positioned parent entirely
 * (cropping rather than stretching), ignores the pointer, fades in once the art is ready and is
 * dimmed behind the middle, where the word is drawn. The library is loaded on demand.
 */
export function AsciiBackground() {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const stage = stageRef.current;
    const pre = preRef.current;
    if (!host || !stage || !pre) {
      return;
    }
    let cancelled = false;
    let stop = () => {};
    let observer: ResizeObserver | null = null;
    let frame = 0;

    void Promise.all([
      import("../vendor/ascii-magic/player.js"),
      import("../vendor/ascii-magic/canvas.js"),
      import("../vendor/ascii-magic/pieces/summit-cloud-sea.js"),
    ]).then(([{ play }, { CELL_W, cellAspect }, piece]) => {
      if (cancelled) {
        return;
      }
      const mod = piece as unknown as PieceModule;
      const start = () => {
        stop();
        const { width, height } = host.getBoundingClientRect();
        if (!width || !height) {
          return;
        }
        // The smallest font size whose picture still covers the whole area.
        const { cols, rows } = mod.meta;
        const aspect = cellAspect(mod.meta);
        const fontSize = Math.max(width / (cols * CELL_W), height / (rows * aspect * CELL_W));
        pre.style.fontSize = `${fontSize}px`;
        // The stage is exactly as big as the picture: the library caps the canvas at 100% of it.
        stage.style.width = `${Math.ceil(cols * fontSize * CELL_W)}px`;
        stage.style.height = `${Math.ceil(rows * fontSize * CELL_W * aspect)}px`;
        stop = play(pre, mod, { look: { look: LOOK } });
        host.style.opacity = String(STRENGTH);
      };
      start();
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(start);
      });
      observer.observe(host);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      stop();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden opacity-0 transition-opacity duration-500 [-webkit-mask-image:radial-gradient(ellipse_55%_20%_at_50%_50%,rgba(0,0,0,0.25),#000_100%)] [mask-image:radial-gradient(ellipse_55%_20%_at_50%_50%,rgba(0,0,0,0.25),#000_100%)]"
    >
      <div
        ref={stageRef}
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 transition-none"
      >
        <pre ref={preRef} className="m-0 font-mono leading-none text-cg-ink transition-none" />
      </div>
    </div>
  );
}
