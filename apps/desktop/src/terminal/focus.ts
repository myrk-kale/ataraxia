/** The element that has focus now, unless it is just the page body. */
export function currentFocus(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * Gives focus back to `previous` after the terminal closed, when it still exists and
 * focus is free. The panel is already out of the DOM, so focus that was inside it is on
 * the body; focus the user moved elsewhere is left alone.
 */
export function restoreFocus(previous: HTMLElement | null): void {
  if (previous?.isConnected && (!document.activeElement || document.activeElement === document.body)) {
    previous.focus();
  }
}
