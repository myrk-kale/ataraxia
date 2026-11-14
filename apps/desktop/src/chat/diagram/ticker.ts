/**
 * One animation loop for every diagram on the page. It runs only while somebody is listening
 * and stops by itself when the last one leaves, so a page of diagrams that are at rest does
 * no work at all.
 */
type Listener = (now: number) => void;

const listeners = new Set<Listener>();
let frame = 0;

function tick(now: number) {
  frame = 0;
  // A listener may leave while it is called.
  for (const listener of [...listeners]) {
    listener(now);
  }
  if (listeners.size > 0) {
    frame = requestAnimationFrame(tick);
  }
}

/** Calls `listener` on every animation frame until the returned function is called. */
export function onFrame(listener: Listener): () => void {
  listeners.add(listener);
  if (frame === 0) {
    frame = requestAnimationFrame(tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}

/** How many are listening, for tests and for the diagnostics. */
export const listening = (): number => listeners.size;
