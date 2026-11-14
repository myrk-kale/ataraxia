import { Pause, Scan, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TRAFFIC_LIGHTS_INSET, useTitlebarInset } from "../../app/titlebar";
import { Button } from "../../ui/Button";
import { EffectSelect } from "./EffectSelect";
import type { EffectId } from "./effects";
import { CELL_H, CELL_W, sharedRenderer } from "./gpu";
import { useDevicePixelRatio } from "./hooks";
import type { Scene } from "./scene";
import { useDiagramPlayer } from "./useDiagramPlayer";
import { clampPan, fitZoom, maxZoomFor, zoomAround, type Pan } from "./viewport";

const STEP = 1.25;
const KEY_PAN = 48;
/** A press that moves less than this is a click, not the start of a drag. */
const DRAG_PX = 4;
const MIN_ZOOM = 0.25;

interface View extends Pan {
  zoom: number;
}

/**
 * A diagram taken up to the whole window, since it is nearly a picture. It can be zoomed (with
 * the wheel or a pinch, the buttons or + and -) and moved by dragging it or with the arrow keys;
 * the drawing is made again at each zoom, so it stays sharp. A click holds the animation, as in
 * the reply.
 */
export function DiagramViewer({
  scene,
  source,
  effect,
  loop,
  onEffect,
  onClose,
  onUnavailable,
}: {
  scene: Scene;
  source: string;
  effect: EffectId | "none";
  loop: boolean;
  onEffect: (effect: EffectId | "none") => void;
  onClose: () => void;
  onUnavailable: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const ratio = useDevicePixelRatio();
  // On macOS the window buttons float over the top left corner, and this covers them.
  const titlebarInset = useTitlebarInset();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View | null>(null);
  const [dragging, setDragging] = useState(false);
  const natural = useMemo(() => ({ width: scene.width * CELL_W, height: scene.height * CELL_H }), [scene]);
  const maxZoom = maxZoomFor(natural, ratio, sharedRenderer()?.maxSize ?? 4096);
  const fit = fitZoom(natural, size, maxZoom);
  const zoom = view?.zoom ?? fit;
  const { canvasRef, state, animated, toggle } = useDiagramPlayer({
    scene,
    source,
    effect,
    loop,
    active: true,
    scale: ratio * zoom,
    variant: "viewer",
    onUnavailable,
  });

  // A dialog the page owns: the browser keeps focus in it, closes it on Esc and puts focus back.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    // Where focus was, to put it back when this closes: closing through the page removes the
    // dialog without the browser's own `close`, which is what would do it.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    // Focus goes to the diagram, where the keys that move and zoom it are heard.
    viewportRef.current?.focus();
    return () => {
      if (dialog?.open) {
        dialog.close();
      }
      if (opener?.isConnected) {
        opener.focus();
      }
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const sizer = new ResizeObserver(([entry]) => {
      if (entry) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    sizer.observe(viewport);
    return () => sizer.disconnect();
  }, []);

  const centred = useCallback(
    (z: number): View => ({
      zoom: z,
      x: (size.width - natural.width * z) / 2,
      y: (size.height - natural.height * z) / 2,
    }),
    [natural, size],
  );

  // The first look is the whole diagram, centred.
  useEffect(() => {
    if (view === null && size.width > 0 && size.height > 0) {
      setView(centred(fit));
    }
  }, [view, size, fit, centred]);

  const apply = useCallback(
    (next: View) => {
      const bounded = Math.min(maxZoom, Math.max(Math.min(MIN_ZOOM, fit), next.zoom));
      const pan = clampPan({ x: next.x, y: next.y }, { width: natural.width * bounded, height: natural.height * bounded }, size);
      setView({ zoom: bounded, ...pan });
    },
    [fit, maxZoom, natural, size],
  );

  const zoomBy = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      const current = view ?? centred(fit);
      const target = Math.min(maxZoom, Math.max(Math.min(MIN_ZOOM, fit), current.zoom * factor));
      const focus = at ?? { x: size.width / 2, y: size.height / 2 };
      apply({ zoom: target, ...zoomAround(current, current.zoom, target, focus) });
    },
    [apply, centred, fit, maxZoom, size, view],
  );

  // The wheel (and a trackpad's pinch, which arrives as a wheel with Ctrl) zooms where the
  // pointer is. It has to be a listener that may cancel the event, or the page would zoom too.
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const box = viewport!.getBoundingClientRect();
      const speed = event.ctrlKey ? 0.01 : 0.0018;
      zoomByRef.current(Math.exp(-event.deltaY * speed), { x: event.clientX - box.left, y: event.clientY - box.top });
    }
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  // Dragging moves the diagram; a press that hardly moves is a click and holds the animation.
  const press = useRef<{ x: number; y: number; start: View; moved: boolean } | null>(null);
  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !view) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = { x: event.clientX, y: event.clientY, start: view, moved: false };
  }
  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const held = press.current;
    if (!held) {
      return;
    }
    const dx = event.clientX - held.x;
    const dy = event.clientY - held.y;
    if (!held.moved && Math.hypot(dx, dy) < DRAG_PX) {
      return;
    }
    held.moved = true;
    setDragging(true);
    apply({ zoom: held.start.zoom, x: held.start.x + dx, y: held.start.y + dy });
  }
  function onPointerUp() {
    const held = press.current;
    press.current = null;
    setDragging(false);
    if (held && !held.moved && animated) {
      toggle();
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    // Nothing typed in here is meant for the chat or the shortcuts behind this window.
    event.stopPropagation();
    const current = view ?? centred(fit);
    switch (event.key) {
      case "+":
      case "=":
        event.preventDefault();
        zoomBy(STEP);
        break;
      case "-":
      case "_":
        event.preventDefault();
        zoomBy(1 / STEP);
        break;
      case "0":
        event.preventDefault();
        setView(centred(fit));
        break;
      case "ArrowLeft":
        event.preventDefault();
        apply({ ...current, x: current.x + KEY_PAN });
        break;
      case "ArrowRight":
        event.preventDefault();
        apply({ ...current, x: current.x - KEY_PAN });
        break;
      case "ArrowUp":
        event.preventDefault();
        apply({ ...current, y: current.y + KEY_PAN });
        break;
      case "ArrowDown":
        event.preventDefault();
        apply({ ...current, y: current.y - KEY_PAN });
        break;
      case " ":
      case "Enter":
        if (event.target === viewportRef.current && animated) {
          event.preventDefault();
          toggle();
        }
        break;
    }
  }

  const shown = view ?? centred(fit);
  return (
    <dialog
      ref={dialogRef}
      aria-label="Diagram, full screen"
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none border-0 bg-cg-panel p-0 text-cg-ink"
      onCancel={(event) => {
        // Esc: close it through the page, which owns it.
        event.preventDefault();
        onClose();
      }}
      onKeyDown={onKeyDown}
    >
      {/* The dialog keeps the browser's own display, or it would never hide; the layout is inside. */}
      <div className="flex h-full flex-col">
        <header
          className="flex flex-none items-center gap-2 border-b border-cg-line px-4 py-2.5"
          data-tauri-drag-region
          style={titlebarInset ? { paddingLeft: TRAFFIC_LIGHTS_INSET } : undefined}
        >
          <h2 className="text-ui font-semibold">Diagram</h2>
          <EffectSelect value={effect} onChange={onEffect} />
          <div aria-label="Zoom" className="ml-auto flex items-center gap-1" role="group">
            <Button aria-label="Zoom out" disabled={zoom <= Math.min(MIN_ZOOM, fit) + 1e-6} variant="icon" onClick={() => zoomBy(1 / STEP)}>
              <ZoomOut size={15} />
            </Button>
            <span aria-live="polite" className="w-12 text-center text-small text-cg-muted-strong tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
            <Button aria-label="Zoom in" disabled={zoom >= maxZoom - 1e-6} variant="icon" onClick={() => zoomBy(STEP)}>
              <ZoomIn size={15} />
            </Button>
            <Button aria-label="Fit to the window" title="Fit to the window (0)" variant="icon" onClick={() => setView(centred(fit))}>
              <Scan size={15} />
            </Button>
          </div>
          <Button aria-label="Close" className="ml-1" title="Close (Esc)" variant="icon" onClick={onClose}>
            <X size={16} />
          </Button>
        </header>
        <div
          ref={viewportRef}
          aria-describedby="diagram-viewer-alt"
          aria-label="Diagram. Drag to move it, scroll to zoom, plus and minus zoom, zero fits it to the window, and Space pauses it."
          className={`relative min-h-0 flex-1 touch-none overflow-hidden outline-offset-[-2px] ${
            dragging ? "cursor-grabbing" : "cursor-grab"
          }`}
          role="group"
          tabIndex={0}
          onPointerCancel={onPointerUp}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className="absolute top-0 left-0 max-w-none"
            style={{
              width: natural.width * shown.zoom,
              height: natural.height * shown.zoom,
              transform: `translate(${shown.x}px, ${shown.y}px)`,
              visibility: view === null ? "hidden" : "visible",
            }}
          />
          <span className="sr-only" id="diagram-viewer-alt">
            {scene.alt}
          </span>
          <p className="pointer-events-none absolute bottom-2 left-3 flex items-center gap-2 text-small text-cg-muted">
            Drag to move · scroll to zoom{animated ? " · click to pause" : ""}
            {state === "paused" ? (
              <span className="flex items-center gap-1 rounded-cg-sm border border-cg-line-strong bg-cg-panel px-1.5 py-0.5 text-cg-muted-strong" role="status">
                <Pause aria-hidden="true" size={11} />
                Paused
              </span>
            ) : null}
          </p>
        </div>
      </div>
    </dialog>
  );
}
