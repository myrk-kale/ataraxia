import { useEffect, useRef, useState, type RefObject } from "react";
import { browserSetBounds, browserSetVisible } from "../lib/browser";

/**
 * What puts something over the browser's page. The page is a native view drawn above the whole
 * interface, so a dialog, a menu or a list that opens over it would be hidden behind it; while one
 * is open the page steps aside and the picture of it that was taken a moment ago stands in.
 */
const OVER = "dialog, [role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox'], [aria-modal='true']";

/** Closed containers keep their descendants' roles in the DOM, even though none are on screen. */
function isOpenOver(element: Element): boolean {
  for (let container: Element | null = element; container; container = container.parentElement) {
    if (container.hasAttribute("popover")) {
      try {
        if (!container.matches(":popover-open")) return false;
      } catch {
        return false;
      }
    }
    if (container.matches("dialog:not([open]), [hidden]")) return false;
    const style = window.getComputedStyle(container);
    if (style.display === "none" || style.contentVisibility === "hidden") {
      return false;
    }
  }
  const visibility = window.getComputedStyle(element).visibility;
  return visibility !== "hidden" && visibility !== "collapse";
}

export function useSomethingOver(enabled: boolean): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setOver(false);
      return;
    }
    const look = () => setOver(Array.from(document.querySelectorAll(OVER)).some(isOpenOver));
    look();
    const observer = new MutationObserver(look);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "aria-modal", "open", "popover", "hidden", "class", "style"] });
    // A popover opens and closes without touching an attribute; the toggle event does not bubble.
    document.addEventListener("toggle", look, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("toggle", look, true);
    };
  }, [enabled]);
  return over;
}

/**
 * Keeps the native page on the box this element occupies: where the page is told to be, and
 * whether it is to be seen at all. Everything is reported after layout, once per frame at most.
 */
export function useViewport(target: RefObject<HTMLElement | null>, active: boolean, hidden: boolean): void {
  const frame = useRef(0);
  const last = useRef("");

  useEffect(() => {
    const element = target.current;
    if (!active || !element) {
      return;
    }
    const report = () => {
      frame.current = 0;
      const box = element.getBoundingClientRect();
      const key = `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}`;
      if (key !== last.current && box.width > 1 && box.height > 1) {
        last.current = key;
        void browserSetBounds(box.left, box.top, box.width, box.height).catch(() => undefined);
      }
    };
    const schedule = () => {
      if (!frame.current) {
        frame.current = requestAnimationFrame(report);
      }
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    // Anything above it that scrolls or animates in moves the box without resizing it.
    window.addEventListener("scroll", schedule, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (frame.current) {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
      }
    };
  }, [target, active]);

  useEffect(() => {
    void browserSetVisible(active && !hidden).catch(() => undefined);
    return () => {
      if (active) {
        void browserSetVisible(false).catch(() => undefined);
      }
    };
  }, [active, hidden]);
}
