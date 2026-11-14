/** The geometry of the full screen view, kept apart from the component so it can be tested. */

export interface Pan {
  x: number;
  y: number;
}

export interface Box {
  width: number;
  height: number;
}

/** The zoom at which a drawing fits a window with some room round it, never past `max`. */
export function fitZoom(natural: Box, window: Box, max: number, room = 64): number {
  if (window.width <= 0 || window.height <= 0) {
    return 1;
  }
  const fit = Math.min((window.width - room) / natural.width, (window.height - room) / natural.height);
  return Math.min(max, Math.max(0.1, fit));
}

/**
 * The most the drawing may be zoomed. The canvas it is drawn on cannot be wider or taller than
 * the card allows, and its area is held to a size that is cheap to keep, so a big diagram stops
 * sooner than a small one.
 */
export function maxZoomFor(natural: Box, ratio: number, maxSide: number, maxArea = 16_000_000, cap = 8): number {
  return Math.max(
    0.25,
    Math.min(
      cap,
      maxSide / (natural.width * ratio),
      maxSide / (natural.height * ratio),
      Math.sqrt(maxArea / (natural.width * natural.height)) / ratio,
    ),
  );
}

/**
 * Where the drawing goes when it is zoomed from `from` to `to` about a point of the window, so
 * that the point of the drawing under it stays under it.
 */
export function zoomAround(at: Pan, from: number, to: number, point: Pan): Pan {
  const ratio = to / from;
  return { x: point.x - (point.x - at.x) * ratio, y: point.y - (point.y - at.y) * ratio };
}

/**
 * Keeps a drawing from being dragged out of reach: some of it always stays in the window. A
 * drawing smaller than the window stays inside it.
 */
export function clampPan(at: Pan, drawing: Box, window: Box, keep = 80): Pan {
  const along = (position: number, length: number, room: number) => {
    if (length <= room) {
      return Math.min(room - length, Math.max(0, position));
    }
    return Math.min(room - keep, Math.max(keep - length, position));
  };
  return { x: along(at.x, drawing.width, window.width), y: along(at.y, drawing.height, window.height) };
}
