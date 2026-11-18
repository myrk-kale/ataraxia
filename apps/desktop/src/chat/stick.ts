/** How near the bottom counts as being at it, once the reader has left and comes back. */
export const REATTACH_PX = 24;

/**
 * Whether the transcript keeps following the stream after the scroll area moved. Tokens arrive
 * many times a second and each one pins the view to the bottom, so the moment the reader scrolls
 * up must win at once: any move upward that was not the pin itself lets go, however small it is,
 * and only being back at the bottom takes hold again.
 *
 * `distance` is how far the view is from the bottom; `top` and `lastTop` are the scroll position
 * now and at the previous event.
 */
export function stickAfterScroll(stuck: boolean, top: number, lastTop: number, distance: number): boolean {
  if (distance <= REATTACH_PX) {
    return true;
  }
  if (top < lastTop - 1) {
    return false;
  }
  return stuck;
}

/** Keys that move the view up when the scroll area, not a field, has the focus. */
export function isUpwardKey(key: string, shiftKey: boolean): boolean {
  return key === "PageUp" || key === "Home" || key === "ArrowUp" || (key === " " && shiftKey);
}
