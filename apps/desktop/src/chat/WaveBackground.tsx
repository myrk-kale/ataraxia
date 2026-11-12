import { useEffect, useRef } from "react";
import { drawWaves, parseWaveColor, type WaveColor } from "./wave";

const FALLBACK_COLOR: WaveColor = { r: 190, g: 233, b: 161 };
const FRAME_MS = 33;
const BASE_INTENSITY = 0.5;
/** Behind messages the field stays visible but gives way to the text. */
const QUIET_GAIN = 0.55;

type Palette = { color: WaveColor; boost: number };

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const boost = Number(style.getPropertyValue("--cg-wave-boost"));
  return {
    color: parseWaveColor(style.getPropertyValue("--cg-wave")) ?? FALLBACK_COLOR,
    boost: Number.isFinite(boost) && boost > 0 ? boost : 1,
  };
}

/**
 * The animated dot waves behind the chat. It fills its positioned parent, ignores the pointer,
 * follows the theme, pauses while the window is hidden and holds still for people who prefer
 * reduced motion. `quiet` turns it down once messages are on screen.
 */
export function WaveBackground({ quiet }: { quiet: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const quietRef = useRef(quiet);
  const redrawRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    quietRef.current = quiet;
    redrawRef.current();
  }, [quiet]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      return;
    }
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let palette = readPalette();
    let width = 0;
    let height = 0;
    let elapsed = 0;
    let last = performance.now();
    let frameId = 0;

    const paint = () => {
      drawWaves(ctx, width, height, elapsed, {
        intensity: BASE_INTENSITY,
        gain: (quietRef.current ? QUIET_GAIN : 1) * palette.boost,
        color: palette.color,
      });
    };
    redrawRef.current = paint;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint();
    };

    const tick = (now: number) => {
      frameId = requestAnimationFrame(tick);
      const delta = now - last;
      if (delta < FRAME_MS) {
        return;
      }
      last = now;
      elapsed += delta;
      paint();
    };

    const running = () => !motion.matches && !document.hidden;
    const sync = () => {
      cancelAnimationFrame(frameId);
      if (running()) {
        last = performance.now();
        frameId = requestAnimationFrame(tick);
      } else {
        paint();
      }
    };

    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(canvas);
    // The theme switches by changing the root element's class, which moves the palette.
    const themeObserver = new MutationObserver(() => {
      palette = readPalette();
      paint();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    document.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", sync);
    resize();
    sync();

    return () => {
      cancelAnimationFrame(frameId);
      sizeObserver.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", sync);
      motion.removeEventListener("change", sync);
      redrawRef.current = () => undefined;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full [-webkit-mask-image:radial-gradient(ellipse_90%_85%_at_50%_50%,#000_45%,transparent_100%)] [mask-image:radial-gradient(ellipse_90%_85%_at_50%_50%,#000_45%,transparent_100%)]"
    />
  );
}
