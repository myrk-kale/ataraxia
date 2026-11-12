import { useEffect, useRef, useState } from "react";
import { INTRO_CEILING, INTRO_MS, introShape, REVEAL_START_MS, revealRadius } from "./intro";
import { drawWaves, parseWaveColor, type WaveColor } from "./wave";

// Used only if the theme tokens cannot be read: the dark theme is the default look.
const FALLBACK_COLOR: WaveColor = { r: 255, g: 255, b: 255 };
const FALLBACK_CANVAS = "#111211";
const INTENSITY = 1;
const GAIN = 3;

function readPalette(): { color: WaveColor; boost: number; canvas: string } {
  const style = getComputedStyle(document.documentElement);
  const boost = Number(style.getPropertyValue("--cg-wave-boost"));
  return {
    color: parseWaveColor(style.getPropertyValue("--cg-wave")) ?? FALLBACK_COLOR,
    boost: Number.isFinite(boost) && boost > 0 ? boost : 1,
    canvas: style.getPropertyValue("--cg-canvas").trim() || FALLBACK_CANVAS,
  };
}

/**
 * The opening of the app: dots bloom out of the centre of the window, shock rings run through
 * them, and the interface (already rendered underneath) opens up as a circle that sweeps to the
 * corners with a bright crest of dots on its edge, settling into place as it does. Skipped for
 * people who prefer reduced motion.
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
    // The interface eases in from slightly larger while the opening sweeps across it.
    const app = document.getElementById("root")?.animate(
      [{ transform: "scale(1.045)" }, { transform: "scale(1)" }],
      {
        delay: REVEAL_START_MS,
        duration: INTRO_MS - REVEAL_START_MS,
        easing: "cubic-bezier(0.22, 0.8, 0.2, 1)",
        fill: "backwards",
      },
    );
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
      ctx.globalCompositeOperation = "source-over";
      drawWaves(ctx, width, height, elapsed, {
        intensity: INTENSITY,
        gain: GAIN * palette.boost,
        color: palette.color,
        ceiling: INTRO_CEILING,
        shape: introShape(elapsed, width, height),
      });
      // The backdrop goes behind the dots, with the opening cut out of it.
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = palette.canvas;
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.arc(width / 2, height / 2, revealRadius(elapsed, width, height), 0, Math.PI * 2);
      ctx.fill("evenodd");
      frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(frameId);
      app?.cancel();
    };
  }, [done]);

  if (done) {
    return null;
  }
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[100]">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
