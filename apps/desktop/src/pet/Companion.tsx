import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { SessionId } from "../lib/workspace";
import { useCompanionActivity, type PetState } from "./activity";
import { nudge, placement, positionAt, sizeOf, type PetPosition } from "./config";
import { Sprite } from "./Sprite";
import { updatePet, usePet } from "./store";

/** How far the pointer has to travel before a press is a drag and not a click. */
const DRAG_FROM = 4;
const STEP = 12;
const BIG_STEP = 48;
/** Mini mode is a pill; this is the room it is given when it is kept inside the window. */
const MINI = 150;

const DOT: Record<PetState, string> = {
  idle: "bg-cg-control",
  running: "bg-cg-accent",
  "needs-input": "bg-cg-amber",
  ready: "bg-cg-green",
  blocked: "bg-cg-red",
};

function useView() {
  const read = () => ({ width: window.innerWidth, height: window.innerHeight });
  const [view, setView] = useState(read);
  useEffect(() => {
    const onResize = () => setView(read());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return view;
}

/**
 * The companion: a small animated character that floats over the interface and shows, whatever
 * space you are in, what your agents are doing: working, waiting for you, done, or stopped with an
 * error. Drag it anywhere (it stays where you leave it), click it for its menu, or move it with
 * the arrow keys when it has the focus. Its bubble says what is going on and takes you to the chat.
 * Mini shows only the status. It is still with reduced motion.
 */
export function Companion({
  chats,
  viewing,
  onOpenChat,
  onCustomize,
}: {
  chats: readonly { id: SessionId; title: string }[];
  /** The chat on screen, if the chat space is. */
  viewing: SessionId | null;
  onOpenChat: (id: SessionId) => void;
  onCustomize: () => void;
}) {
  const pet = usePet();
  const { summary, acknowledge } = useCompanionActivity(chats, viewing);
  const view = useView();
  const [live, setLive] = useState<PetPosition | null>(null);
  const [menu, setMenu] = useState(false);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  const mini = pet.mode === "mini";
  const size = mini ? MINI : sizeOf(pet);
  const where = placement(live ?? pet.position, view, size);

  const close = useCallback(() => setMenu(false), []);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenu(false);
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [menu]);

  if (pet.mode === "off") {
    return null;
  }

  function down(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, left: where.left, top: where.top, moved: false };
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const start = drag.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < DRAG_FROM) return;
    start.moved = true;
    setMenu(false);
    setLive(positionAt(start.left + dx, start.top + dy, view, size));
  }

  function up(event: PointerEvent<HTMLButtonElement>) {
    const start = drag.current;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (start?.moved) {
      justDragged.current = true;
      // The click that follows a drag is not a click on the pet.
      window.setTimeout(() => (justDragged.current = false), 0);
      if (live) updatePet({ position: live });
    }
    setLive(null);
  }

  function key(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const delta = arrows[event.key];
    if (delta) {
      event.preventDefault();
      updatePet({ position: nudge(pet.position, delta[0], delta[1], view, size) });
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (menu) setMenu(false);
      else updatePet({ position: null });
    }
  }

  const attention = summary.state !== "idle" && summary.sessionId;
  const bubbleOnRight = where.left + size / 2 < view.width / 2;
  const menuAbove = where.top > view.height / 2;

  function openChat() {
    if (summary.sessionId) {
      acknowledge(summary.sessionId);
      onOpenChat(summary.sessionId);
    }
  }

  return (
    <div ref={root} className="fixed z-40 select-none" style={{ left: where.left, top: where.top, width: size, height: mini ? "auto" : size }}>
      {mini ? (
        <button
          aria-haspopup="menu"
          aria-label={`${pet.name}: ${summary.text || "all quiet"}. Drag to move, press to open the menu.`}
          className={`flex w-full touch-none items-center gap-2 rounded-full border border-cg-line-strong bg-cg-float px-3 py-1.5 text-left text-small text-cg-ink shadow-cg-pop ${drag.current ? "cursor-grabbing" : "cursor-grab"} focus-visible:outline-2 focus-visible:outline-cg-accent`}
          type="button"
          onClick={() => !justDragged.current && setMenu((open) => !open)}
          onKeyDown={key}
          onPointerCancel={up}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
        >
          <span aria-hidden="true" className={`h-2 w-2 flex-none rounded-full ${DOT[summary.state]} ${summary.state === "running" ? "motion-safe:animate-pulse" : ""}`} />
          <span className="min-w-0 truncate">{summary.text || "All quiet"}</span>
        </button>
      ) : (
        <>
          <button
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-label={`${pet.name}. Drag to move, press to open the menu, arrow keys move it.`}
            className={`block touch-none rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-cg-accent ${drag.current ? "cursor-grabbing" : "cursor-grab"}`}
            title={pet.name}
            type="button"
            onClick={() => !justDragged.current && setMenu((open) => !open)}
            onKeyDown={key}
            onPointerCancel={up}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
          >
            <Sprite accessory={pet.accessory} color={pet.color} image={pet.image} name={pet.name} size={size} species={pet.species} state={summary.state} />
          </button>
          {attention && !menu ? (
            <button
              className={`absolute top-1 max-w-[240px] rounded-cg-md border border-cg-line-strong bg-cg-float px-3 py-2 text-left text-small leading-snug text-cg-ink shadow-cg-pop hover:bg-cg-tint ${bubbleOnRight ? "left-full ml-2" : "right-full mr-2"}`}
              type="button"
              onClick={openChat}
            >
              <span className="line-clamp-3">{summary.text}</span>
            </button>
          ) : null}
        </>
      )}
      {menu ? (
        <div
          className={`absolute z-10 w-[210px] rounded-cg-md border border-cg-line-strong bg-cg-float p-1 text-small shadow-cg-pop ${menuAbove ? "bottom-full mb-2" : "top-full mt-2"} ${bubbleOnRight ? "left-0" : "right-0"}`}
          role="menu"
          onKeyDown={(event) => event.key === "Escape" && close()}
        >
          {attention ? (
            <button className="flex w-full rounded-cg-sm px-2.5 py-2 text-left text-cg-ink hover:bg-cg-tint" role="menuitem" type="button" onClick={() => { close(); openChat(); }}>
              Open the chat
            </button>
          ) : null}
          <button className="flex w-full rounded-cg-sm px-2.5 py-2 text-left text-cg-ink hover:bg-cg-tint" role="menuitem" type="button" onClick={() => { close(); onCustomize(); }}>
            Customize…
          </button>
          <button className="flex w-full rounded-cg-sm px-2.5 py-2 text-left text-cg-ink hover:bg-cg-tint" role="menuitem" type="button" onClick={() => { close(); updatePet({ mode: mini ? "pet" : "mini" }); }}>
            {mini ? "Show the pet" : "Mini: only the status"}
          </button>
          <button className="flex w-full rounded-cg-sm px-2.5 py-2 text-left text-cg-ink hover:bg-cg-tint" role="menuitem" type="button" onClick={() => { close(); updatePet({ position: null }); }}>
            Back to its corner
          </button>
          <button className="flex w-full rounded-cg-sm px-2.5 py-2 text-left text-cg-ink hover:bg-cg-tint" role="menuitem" type="button" onClick={() => { close(); updatePet({ mode: "off" }); }}>
            Hide (type /pet to bring it back)
          </button>
        </div>
      ) : null}
    </div>
  );
}
