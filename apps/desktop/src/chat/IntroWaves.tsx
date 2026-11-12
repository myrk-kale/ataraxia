import { useEffect, useRef, useState } from "react";
import { INTRO_MS, introOpacity } from "./intro";
import { drawWaves, parseWaveColor, type WaveColor } from "./wave";

// Used only if the theme tokens cannot be read: the dark theme is the default look.
const FALLBACK_COLOR: WaveColor = { r: 255, g: 255, b: 255 };
const INTENSITY = 0.9;
const GAIN = 2.4;

function readPalette(): { color: WaveColor; boost: number } {
  const style = getComputedStyle(document.documentElement);
  const boost = Number(style.getPropertyValue("--cg-wave-boost"));
  return {
    color: parseWaveColor(style.getPropertyValue("--cg-wave")) ?? FALLBACK_COLOR,
    boost: Number.isFinite(boost) && boost > 0 ? boost : 1,
  };
}

/**
 * The opening of the app: dot waves fill the window for about a second and a half, then give
 * way to the interface, which is already rendered underneath. Skipped for people who prefer
 * reduced motion.
 */
export function IntroWaves() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (done || !canvas || !ctx) {
      return;
    }
    const start = performance.now();
    let frameId = 0;
    const frame = (now: number) => {
      const elapsed = now - start;
      if (elapsed >= INTRO_MS) {
        setDone(true);
        return;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const palette = readPalette();
      drawWaves(ctx, width, height, elapsed, {
        intensity: INTENSITY,
        gain: GAIN * palette.boost,
        color: palette.color,
      });
      canvas.parentElement?.style.setProperty("opacity", String(introOpacity(elapsed)));
      frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(frameId);
  }, [done]);

  if (done) {
    return null;
  }
  return (
    <div aria-hidden="true" className="fixed inset-0 z-[100] bg-cg-canvas">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
