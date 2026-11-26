import { ExternalLink, GripHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { browserScreenshot, dismissBrowserPreview, useBrowserPreviewTab, type BrowserTab } from "../lib/browser";

/** Captures are serial: a slow native snapshot must not build a queue of frames. */
function LivePage({ tab, onWatch }: { tab: BrowserTab; onWatch: (id: number) => void }) {
  const [picture, setPicture] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function capture(): Promise<void> {
      if (stopped || pending || document.hidden) return;
      pending = true;
      let delay = 500;
      try {
        const png = await browserScreenshot(tab.id);
        if (!stopped) {
          if (!png) throw new Error("Empty screenshot");
          setPicture(`data:image/png;base64,${png}`);
          setFailed(false);
        }
      } catch {
        delay = 2000;
        if (!stopped) setFailed(true);
      } finally {
        pending = false;
        if (!stopped && !document.hidden) timer = setTimeout(() => void capture(), delay);
      }
    }

    function visibilityChanged(): void {
      clearTimeout(timer);
      if (!document.hidden) void capture();
    }

    void capture();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [tab.id]);

  function watch(): void {
    onWatch(tab.id);
  }

  return (
    <button
      aria-label={`Open browser: ${tab.title || tab.url}`}
      className="block w-full cursor-pointer text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cg-accent"
      type="button"
      onClick={watch}
    >
      <span className="relative block aspect-video overflow-hidden bg-cg-bg">
        {picture ? <img alt="" className="h-full w-full object-contain" height={180} src={picture} width={320} /> : null}
        {!picture || failed ? (
          <span className="absolute inset-0 grid place-items-center bg-cg-panel/90 px-4 text-center text-small text-cg-muted-strong" role="status">
            {failed ? "Preview unavailable. Open browser to watch." : "Getting the browser preview…"}
          </span>
        ) : null}
      </span>
    </button>
  );
}

type Position = { right: number; bottom: number };
type Drag = Position & { x: number; y: number; pointerId: number };

export function BrowserPictureInPicture({ onWatch, hidden = false }: { onWatch: (id: number) => void; hidden?: boolean }) {
  const tab = useBrowserPreviewTab();
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<Drag | null>(null);
  const [position, setPosition] = useState<Position>({ right: 16, bottom: 16 });

  function constrain(next: Position): Position {
    const element = panel.current;
    const parent = element?.parentElement;
    if (!element || !parent) return next;
    return {
      right: Math.max(0, Math.min(next.right, parent.clientWidth - element.offsetWidth)),
      bottom: Math.max(0, Math.min(next.bottom, parent.clientHeight - element.offsetHeight)),
    };
  }

  useEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setPosition((value) => constrain(value)));
    observer.observe(parent);
    return () => observer.disconnect();
  }, [tab?.id, hidden]);

  function startDrag(event: PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    drag.current = { ...position, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>): void {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setPosition(constrain({ right: start.right + start.x - event.clientX, bottom: start.bottom + start.y - event.clientY }));
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>): void {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function moveWithKeyboard(event: KeyboardEvent<HTMLButtonElement>): void {
    const step = event.shiftKey ? 40 : 10;
    const directions: Record<string, Position> = {
      ArrowLeft: { right: step, bottom: 0 }, ArrowRight: { right: -step, bottom: 0 },
      ArrowUp: { right: 0, bottom: step }, ArrowDown: { right: 0, bottom: -step },
    };
    const delta = directions[event.key];
    if (!delta) return;
    event.preventDefault();
    setPosition((value) => constrain({ right: value.right + delta.right, bottom: value.bottom + delta.bottom }));
  }

  function dismiss(): void {
    if (tab) dismissBrowserPreview(tab.id);
  }

  function watch(): void {
    if (tab) onWatch(tab.id);
  }

  if (!tab) return null;
  return (
    <aside aria-label="Agent browser preview" hidden={hidden} ref={panel} style={position} className="absolute z-20 w-72 max-w-[calc(100%-2rem)] overflow-hidden rounded-cg-md border border-cg-line-strong bg-cg-float text-cg-ink shadow-cg-pop">
      <div className="flex items-center border-b border-cg-line">
        <button aria-label="Move browser preview" title="Drag to move. Arrow keys move; Shift moves faster." className="flex h-9 min-w-0 flex-1 touch-none cursor-grab items-center gap-2 pl-2.5 text-cg-muted-strong select-none active:cursor-grabbing focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cg-accent" type="button" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onKeyDown={moveWithKeyboard}>
          <GripHorizontal aria-hidden="true" size={14} className="shrink-0" />
          <span className="truncate text-small" title={tab.url}>{tab.title || tab.url}</span>
        </button>
        <button aria-label="Open full browser" className="grid h-9 w-9 flex-none cursor-pointer place-items-center text-cg-muted-strong hover:text-cg-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cg-accent" type="button" onClick={watch}>
          <ExternalLink aria-hidden="true" size={14} />
        </button>
        <button aria-label="Dismiss browser preview" className="grid h-9 w-9 flex-none cursor-pointer place-items-center text-cg-muted-strong hover:text-cg-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cg-accent" type="button" onClick={dismiss}>
          <X aria-hidden="true" size={14} />
        </button>
      </div>
      {hidden ? null : <LivePage key={tab.id} tab={tab} onWatch={onWatch} />}
    </aside>
  );
}
