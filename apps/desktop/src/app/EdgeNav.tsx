import { useEffect, useRef } from "react";
import { SPACES, type SpaceId } from "./spaces";

function Dot({
  label,
  active,
  small,
  onSelect,
}: {
  label: string;
  active: boolean;
  small: boolean;
  onSelect: () => void;
}) {
  // Artifact spaces are a size smaller than workspaces; both idle dots keep 3:1 against the panel.
  const size = small ? "h-1.5 w-1.5" : "h-2 w-2";
  const idle = "bg-cg-control";
  return (
    <button
      aria-current={active ? "page" : undefined}
      aria-label={label}
      className="group relative flex h-7 w-7 items-center justify-center rounded-full"
      type="button"
      onClick={onSelect}
    >
      <span
        className={`${size} rounded-full transition-all duration-200 group-hover:scale-125 ${
          active
            ? "bg-cg-accent shadow-[0_0_0_5px_var(--cg-accent-bg)]"
            : `${idle} group-hover:bg-cg-muted-strong`
        }`}
      />
      <span className="pointer-events-none absolute top-1/2 right-[34px] translate-x-[3px] -translate-y-1/2 rounded-cg-sm bg-cg-tip-bg px-3 py-2 text-small font-medium whitespace-nowrap text-cg-tip-fg opacity-0 shadow-lg transition-all group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100">
        {label}
      </span>
    </button>
  );
}

export function EdgeNav({
  space,
  onSelect,
}: {
  space: SpaceId;
  onSelect: (space: SpaceId) => void;
}) {
  const nav = useRef<HTMLElement>(null);
  const current = useRef(space);
  current.current = space;
  const select = useRef(onSelect);
  select.current = onSelect;

  // The wheel over the dots moves between spaces, one step per flick: a trackpad sends a burst of
  // events for one gesture, so steps are spaced out and the page behind never scrolls.
  useEffect(() => {
    const element = nav.current;
    if (!element) {
      return;
    }
    let last = 0;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const now = performance.now();
      if (Math.abs(event.deltaY) < 4 || now - last < 280) {
        return;
      }
      last = now;
      // At the first or last dot the wheel stops there instead of wrapping around.
      const index = SPACES.findIndex((item) => item.id === current.current);
      const target = SPACES[Math.min(SPACES.length - 1, Math.max(0, index + (event.deltaY > 0 ? 1 : -1)))];
      if (target && target.id !== current.current) {
        select.current(target.id);
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const workspaces = SPACES.filter((item) => item.group === "workspace");
  const artifacts = SPACES.filter((item) => item.group === "artifact");
  return (
    <nav
      ref={nav}
      aria-label="Spaces"
      className="fixed top-1/2 right-3 z-40 flex w-[25px] -translate-y-1/2 flex-col items-center gap-3 rounded-cg-lg border border-cg-line bg-cg-float py-3.5 shadow-cg-lift"
    >
      <div className="flex w-full flex-col items-center gap-2">
        {workspaces.map((item) => (
          <Dot
            key={item.id}
            active={item.id === space}
            label={item.label}
            small={false}
            onSelect={() => onSelect(item.id)}
          />
        ))}
      </div>
      <div className="relative flex w-full flex-col items-center gap-2 pt-3.5 before:absolute before:top-px before:h-[9px] before:w-px before:bg-cg-control before:content-['']">
        {artifacts.map((item) => (
          <Dot
            key={item.id}
            active={item.id === space}
            label={item.label}
            small
            onSelect={() => onSelect(item.id)}
          />
        ))}
      </div>
    </nav>
  );
}
