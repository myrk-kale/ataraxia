import { useEffect, useRef } from "react";
import { drawWaves, parseWaveColor, WaveField, type WaveColor } from "./wave";

// Used only if the theme tokens cannot be read: the dark theme is the default look.
const FALLBACK_COLOR: WaveColor = { r: 255, g: 255, b: 255 };
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
    // Dragging through the field pushes the dots along; they ease back by themselves.
    const field = new WaveField();

    const paint = () => {
      drawWaves(ctx, width, height, elapsed, {
        intensity: BASE_INTENSITY,
        gain: (quietRef.current ? QUIET_GAIN : 1) * palette.boost,
        color: palette.color,
        field,
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
      field.resize(width, height);
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
      field.step(delta);
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

    // Press the empty background and drag to move the waves; a plain click gives them a light
    // push. Only surfaces marked `data-wave-surface` count, so buttons, inputs and message text
    // never trigger it. People who prefer reduced motion get no moving effect at all.
    type Drag = { id: number; x: number; y: number; travelled: number };
    let drag: Drag | null = null;
    const local = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const noSelect = (event: Event) => event.preventDefault();
    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) {
        return;
      }
      const point = local(event);
      const mx = point.x - drag.x;
      const my = point.y - drag.y;
      if (Math.hypot(mx, my) < 0.5) {
        return;
      }
      field.drag(point.x, point.y, mx, my);
      drag.travelled += Math.hypot(mx, my);
      drag.x = point.x;
      drag.y = point.y;
    };
    const release = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) {
        return;
      }
      if (drag.travelled < 4) {
        field.poke(drag.x, drag.y);
      }
      drag = null;
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("selectstart", noSelect);
    };
    const press = (event: PointerEvent) => {
      const target = event.target;
      if (
        drag ||
        event.button !== 0 ||
        !running() ||
        !(target instanceof HTMLElement) ||
        !target.hasAttribute("data-wave-surface")
      ) {
        return;
      }
      const point = local(event);
      drag = { id: event.pointerId, x: point.x, y: point.y, travelled: 0 };
      document.body.style.cursor = "grabbing";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", release);
      window.addEventListener("pointercancel", release);
      // Dragging across text must not start selecting it.
      window.addEventListener("selectstart", noSelect);
    };
    const surface = canvas.parentElement;
    surface?.addEventListener("pointerdown", press);

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
      surface?.removeEventListener("pointerdown", press);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("selectstart", noSelect);
      document.body.style.cursor = "";
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
