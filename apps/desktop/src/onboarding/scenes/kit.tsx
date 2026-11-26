import type { CSSProperties, ReactNode } from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

/** Every scene is drawn on this canvas and scaled to the box the tour gives it. */
export const SCENE = { width: 600, height: 560, fps: 30 } as const;

const settle = Easing.bezier(0.16, 1, 0.3, 1);
const overshoot = Easing.bezier(0.34, 1.56, 0.64, 1);

/** 0 before `from`, 1 after `from + length`, eased in between. */
export function progress(frame: number, from: number, length = 18, easing: (value: number) => number = settle): number {
  return interpolate(frame, [from, from + length], [0, 1], { easing, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}

/** Rises into place and fades in at `at`. */
export function Appear({ at, children, lift = 14, className, style }: { at: number; children: ReactNode; lift?: number; className?: string; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  const shown = progress(frame, at);
  return (
    <div className={className} style={{ ...style, opacity: shown, translate: `0px ${(1 - shown) * lift}px` }}>
      {children}
    </div>
  );
}

/** Springs up from a smaller size at `at`. */
export function Pop({ at, children, className, style }: { at: number; children: ReactNode; className?: string; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  const shown = progress(frame, at, 16, overshoot);
  return (
    <div className={className} style={{ ...style, opacity: Math.min(1, shown * 2), scale: 0.6 + 0.4 * shown }}>
      {children}
    </div>
  );
}

/** The scene fades in and out so that the loop has no seam. */
export function Scene({ children, label }: { children: ReactNode; label: string }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = interpolate(frame, [0, 8, durationInFrames - 14, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div aria-label={label} className="absolute inset-0 flex items-center justify-center overflow-hidden bg-cg-tint text-cg-ink" role="img" style={{ opacity }}>
      {children}
    </div>
  );
}

/** Text that is typed out, one letter at a time, from `start`. */
export function Typed({ text, start, perSecond = 28 }: { text: string; start: number; perSecond?: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const count = Math.max(0, Math.min(text.length, Math.floor(((frame - start) / fps) * perSecond)));
  return <>{text.slice(0, count)}</>;
}

export function Caret({ show = true }: { show?: boolean }) {
  const frame = useCurrentFrame();
  const on = Math.floor(frame / 12) % 2 === 0;
  return <span className="ml-px inline-block h-[1.1em] w-[2px] translate-y-[2px] bg-cg-accent" style={{ opacity: show && on ? 1 : 0 }} />;
}

export function Keycap({ children, pressedAt }: { children: ReactNode; pressedAt?: number }) {
  const frame = useCurrentFrame();
  const down = pressedAt === undefined ? 0 : interpolate(frame, [pressedAt, pressedAt + 4, pressedAt + 12], [0, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <kbd
      className="rounded-[7px] border border-cg-line-strong bg-cg-panel px-2.5 py-1 font-mono text-[15px] font-semibold text-cg-ink shadow-cg-float"
      style={{ translate: `0px ${down * 3}px`, boxShadow: down > 0.3 ? "none" : undefined }}
    >
      {children}
    </kbd>
  );
}

/** A small window with a title bar, the frame most scenes draw their content in. */
export function Window({ title, children, className = "", style }: { title: string; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`overflow-hidden rounded-[14px] border border-cg-line-strong bg-cg-panel shadow-cg-float ${className}`} style={style}>
      <div className="flex items-center gap-1.5 border-b border-cg-line px-3.5 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-cg-control" />
        <span className="h-2.5 w-2.5 rounded-full bg-cg-control" />
        <span className="h-2.5 w-2.5 rounded-full bg-cg-control" />
        <span className="ml-2 text-[13px] text-cg-muted-strong">{title}</span>
      </div>
      {children}
    </div>
  );
}

/** A pointer that glides between places: `path` is a list of [frame, x, y]. */
export function Pointer({ path, clickAt }: { path: readonly (readonly [number, number, number])[]; clickAt?: number }) {
  const frame = useCurrentFrame();
  const frames = path.map((point) => point[0]);
  const ease = { easing: Easing.bezier(0.45, 0, 0.2, 1), extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const x = interpolate(frame, frames, path.map((point) => point[1]), ease);
  const y = interpolate(frame, frames, path.map((point) => point[2]), ease);
  const press = clickAt === undefined ? 0 : interpolate(frame, [clickAt, clickAt + 4, clickAt + 10], [0, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <>
      {clickAt !== undefined ? (
        <span
          className="absolute rounded-full border-2 border-cg-accent"
          style={{ left: x - 16, top: y - 16, width: 32, height: 32, opacity: press ? 1 - progress(frame, clickAt, 14) : 0, scale: 0.4 + progress(frame, clickAt, 14) }}
        />
      ) : null}
      <svg aria-hidden="true" className="absolute" height="26" style={{ left: x, top: y, scale: 1 - press * 0.15 }} viewBox="0 0 24 24" width="26">
        <path d="M4 3l7.5 17.5 2.4-7.2 7.2-2.4z" fill="var(--color-cg-accent)" stroke="var(--color-cg-panel)" strokeLinejoin="round" strokeWidth="1.6" />
      </svg>
    </>
  );
}
