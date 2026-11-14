import { Maximize2, Pause } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { CopyButton } from "../CopyButton";
import { DiagramViewer } from "./DiagramViewer";
import { EffectSelect } from "./EffectSelect";
import type { EffectId } from "./effects";
import { CELL_H, CELL_W } from "./gpu";
import { useDevicePixelRatio } from "./hooks";
import { useDiagramPrefs } from "./prefs";
import type { Scene } from "./scene";
import { useDiagramPlayer } from "./useDiagramPlayer";

/** A drawing narrower than this share of its natural size is scrolled instead of shrunk. */
const SMALLEST_SCALE = 0.72;

/**
 * A flowchart drawn as text on the graphics card. The drawing is `scene`; this puts it on a
 * canvas and animates it while it is in view. A click on the diagram holds the animation and
 * another lets it go; each diagram has its own choice of animation, and opens full screen.
 * `onUnavailable` is called if the graphics card cannot draw it, so the caller can show it
 * another way.
 */
export function AsciiDiagram({
  scene,
  source,
  onUnavailable,
}: {
  scene: Scene;
  source: string;
  onUnavailable: () => void;
}) {
  const prefs = useDiagramPrefs();
  const ratio = useDevicePixelRatio();
  const describedBy = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const [choice, setChoice] = useState<EffectId | "none" | null>(null);
  const [inView, setInView] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [available, setAvailable] = useState(0);
  const effect = choice ?? prefs.effect;
  const { canvasRef, state, animated, reduced, toggle } = useDiagramPlayer({
    scene,
    source,
    effect,
    loop: prefs.loop,
    // Behind the full screen view it is not seen, so it is not drawn.
    active: inView && !viewing,
    scale: ratio,
    onUnavailable,
  });
  const naturalW = scene.width * CELL_W;
  const naturalH = scene.height * CELL_H;
  const scale = available > 0 && naturalW > available ? Math.max(SMALLEST_SCALE, available / naturalW) : 1;

  useEffect(() => {
    const box = boxRef.current;
    if (!box) {
      return;
    }
    const watcher = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false), {
      rootMargin: "120px",
    });
    watcher.observe(box);
    const sizer = new ResizeObserver(([entry]) => setAvailable(entry?.contentRect.width ?? 0));
    sizer.observe(box);
    return () => {
      watcher.disconnect();
      sizer.disconnect();
    };
  }, [scene]);

  const label =
    state === "paused"
      ? "Resume the animation"
      : state === "rest"
        ? "Play the animation again"
        : "Pause the animation";
  const canvasStyle = { width: naturalW * scale, height: naturalH * scale };

  return (
    <figure aria-label="Diagram" className="group/copy relative my-2">
      <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 opacity-0 group-focus-within/copy:opacity-100 group-hover/copy:opacity-100">
        <EffectSelect disabled={reduced} value={effect} onChange={setChoice} />
        <button
          aria-label="Open the diagram full screen"
          className="grid h-[26px] w-[26px] place-items-center rounded-cg-sm border border-cg-line-strong bg-cg-panel text-cg-muted-strong hover:text-cg-ink"
          title="Open full screen, to zoom and move it"
          type="button"
          onClick={() => setViewing(true)}
        >
          <Maximize2 aria-hidden="true" size={13} />
        </button>
        <CopyButton inline read={() => ({ text: source })} what="diagram source" />
      </div>
      <div
        ref={boxRef}
        className="overflow-x-auto rounded-cg-md border border-cg-line bg-cg-panel"
        data-diagram-style={scene.style}
      >
        {/*
          One canvas in both cases, so choosing "no animation" does not swap it for a new one that
          has no size. With an animation, a click is the way to pause, as there is no button for
          it; Enter and Space do the same, so it does not depend on a mouse.
        */}
        <div
          aria-describedby={animated ? describedBy : undefined}
          aria-label={animated ? label : undefined}
          className={`mx-auto block w-fit rounded-cg-sm ${animated ? "cursor-pointer" : ""}`}
          role={animated ? "button" : undefined}
          tabIndex={animated ? 0 : undefined}
          onClick={animated ? toggle : undefined}
          onKeyDown={
            animated
              ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggle();
                  }
                }
              : undefined
          }
        >
          <canvas
            ref={canvasRef}
            aria-hidden={animated ? "true" : undefined}
            aria-label={animated ? undefined : scene.alt}
            className="block max-w-none"
            role={animated ? undefined : "img"}
            style={canvasStyle}
          />
        </div>
      </div>
      <span className="sr-only" id={describedBy}>
        {scene.alt}
      </span>
      <span aria-live="polite" className="pointer-events-none absolute bottom-1.5 left-2 flex" role="status">
        {state === "paused" ? (
          <span className="flex items-center gap-1 rounded-cg-sm border border-cg-line-strong bg-cg-panel px-1.5 py-0.5 text-small text-cg-muted-strong">
            <Pause aria-hidden="true" size={11} />
            Paused
          </span>
        ) : null}
      </span>
      {viewing ? (
        <DiagramViewer
          effect={effect}
          loop={prefs.loop}
          scene={scene}
          source={source}
          onClose={() => setViewing(false)}
          onEffect={setChoice}
          onUnavailable={onUnavailable}
        />
      ) : null}
    </figure>
  );
}
