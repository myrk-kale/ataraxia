/** A spot in the editor, relative to its top left corner (what Monaco reports for a position). */
export type Spot = { top: number; left: number; height: number };

export type MenuBox = { width: number; height: number };

/** Space kept between the menu and the selection, and between the menu and the edges. */
const GAP = 6;
const EDGE = 8;

/**
 * Where the menu sits: just above the start of the selection, or, when there is no room there,
 * just below its end. It never leaves the editor sideways. `null` when the selection is out of view.
 */
export function placeMenu(
  start: Spot | null,
  end: Spot | null,
  viewport: { width: number; height: number },
  menu: MenuBox,
): { top: number; left: number } | null {
  const anchor = start ?? end;
  if (!anchor) {
    return null;
  }
  const left = Math.max(EDGE, Math.min(anchor.left, viewport.width - menu.width - EDGE));
  const above = anchor.top - menu.height - GAP;
  if (start && above >= 0) {
    return { top: above, left };
  }
  const below = end ?? anchor;
  const top = below.top + below.height + GAP;
  if (top + menu.height > viewport.height) {
    // The selection fills the view: float inside it, at the top.
    return { top: EDGE, left };
  }
  return { top, left };
}
