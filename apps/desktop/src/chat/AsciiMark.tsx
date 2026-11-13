import { useEffect, useRef } from "react";
import { brightness, glyphFor, markFor, MAX_ALPHA, quiet, STILL_AT, type Pointer } from "./asciiArt";

const FONT_SIZE = 13;
/** Line height over font size: ASCII cells are taller than they are wide. */
const LINE = 1.15;
/** Frames per second. The motion is slow, so this is plenty and keeps the cost small. */
const FPS = 30;
/** How long the A takes to rise away once the chat has begun, and to come back. */
const RISE_MS = 1800;
const RETURN_MS = 900;

/**
 * The animated ASCII background of the chat (see asciiArt.ts for what it does and why): the A of
 * ATARAXIA while `mark` is set (the chat has not begun), then the A rises away and only the
 * drifting field stays, faint behind the messages. It fills its positioned parent, follows the
 * pointer without taking it, stops while the window is hidden, and is a still picture for people
 * who prefer reduced motion. It is decoration: hidden from assistive technology, and faint where
 * words are.
 */
export function AsciiMark({ mark }: { mark: boolean }) {
  const wanted = useRef(mark);
  wanted.current = mark;
  // Called when `mark` changes, so a still picture can follow it.
  const redraw = useRef<(() => void) | null>(null);
  useEffect(() => redraw.current?.(), [mark]);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const host = canvas?.parentElement;
    if (!canvas || !ctx || !host) {
      return;
    }
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let cellW = 0;
    let cellH = 0;
    let color = "#000";
    let font = "";
    let colorAge = 0;
    let pointer: Pointer = null;
    let frameId = 0;
    let last = 0;
    const started = performance.now();
    // 0 with the A in place, 1 once it has risen away. A chat that is already under way starts at 1.
    let lift = wanted.current ? 0 : 1;

    function measure() {
      const rect = host!.getBoundingClientRect();
      width = Math.max(0, Math.floor(rect.width));
      height = Math.max(0, Math.floor(rect.height));
      const ratio = window.devicePixelRatio || 1;
      canvas!.width = Math.max(1, Math.floor(width * ratio));
      canvas!.height = Math.max(1, Math.floor(height * ratio));
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
      readStyle();
      cellW = ctx!.measureText("M").width;
      cellH = FONT_SIZE * LINE;
    }

    // The ink and the font follow the theme and the font the person picked.
    function readStyle() {
      const style = getComputedStyle(canvas!);
      color = style.color;
      font = `${FONT_SIZE}px ${style.fontFamily}`;
      ctx!.font = font;
      ctx!.textBaseline = "top";
    }

    function draw(seconds: number) {
      if (still) {
        lift = wanted.current ? 0 : 1;
      }
      if (!width || !height || !cellW) {
        return;
      }
      ctx!.clearRect(0, 0, width, height);
      ctx!.fillStyle = color;
      const shape = markFor(width, height, lift);
      const cols = Math.ceil(width / cellW);
      const rows = Math.ceil(height / cellH);
      for (let row = 0; row < rows; row += 1) {
        const y = row * cellH;
        for (let col = 0; col < cols; col += 1) {
          const x = col * cellW;
          const point = { x: x + cellW / 2, y: y + cellH / 2 };
          const level = brightness(shape, point, seconds, pointer);
          const glyph = glyphFor(level);
          if (glyph === " ") {
            continue;
          }
          ctx!.globalAlpha = Math.min(1, level) * MAX_ALPHA * quiet(width, height, point, lift);
          ctx!.fillText(glyph, x, y);
        }
      }
      ctx!.globalAlpha = 1;
    }

    function frame(now: number) {
      frameId = requestAnimationFrame(frame);
      if (document.hidden || now - last < 1000 / FPS) {
        return;
      }
      const elapsed = now - last;
      last = now;
      // The A rises away when the chat begins, and comes back, more briefly, if it is emptied.
      const target = wanted.current ? 0 : 1;
      if (lift !== target) {
        const step = elapsed / (target === 1 ? RISE_MS : RETURN_MS);
        lift = target === 1 ? Math.min(1, lift + step) : Math.max(0, lift - step);
      }
      // The theme can change while this is on screen: read the ink again now and then.
      colorAge += 1;
      if (colorAge > FPS * 2) {
        colorAge = 0;
        readStyle();
      }
      draw((now - started) / 1000 + STILL_AT);
    }

    function onMove(event: PointerEvent) {
      const rect = host!.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      pointer = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height ? { x, y } : null;
    }

    // Only a still picture is redrawn on demand; an animated one is already redrawn every frame.
    redraw.current = still ? () => draw(STILL_AT) : null;
    measure();
    const observer = new ResizeObserver(() => {
      measure();
      if (still) {
        draw(STILL_AT);
      }
    });
    observer.observe(host);
    if (still) {
      draw(STILL_AT);
    } else {
      frameId = requestAnimationFrame(frame);
      window.addEventListener("pointermove", onMove);
    }
    // Fonts that load late change the width of a cell.
    void document.fonts?.ready.then(() => {
      measure();
      if (still) {
        draw(STILL_AT);
      }
    });
    return () => {
      redraw.current = null;
      cancelAnimationFrame(frameId);
      observer.disconnect();
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 font-mono text-cg-ink motion-safe:animate-[ascii-in_900ms_ease-out_both]"
    />
  );
}
