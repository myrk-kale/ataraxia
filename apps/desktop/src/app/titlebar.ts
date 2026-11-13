import { useEffect, useState } from "react";

/**
 * On macOS the app draws its own title bar: the window content runs under the three window buttons
 * (see `titleBarStyle: "Overlay"` in `tauri.conf.json`), so the header has to leave room for them.
 * Other systems keep the native title bar, and the plain browser preview has none.
 */
export function usesOverlayTitlebar(env: { userAgent: string; tauri: boolean }): boolean {
  return env.tauri && /\bMac OS X\b|\bMacintosh\b/.test(env.userAgent);
}

/**
 * Room the header leaves on its left for the window buttons. In pixels, not rem: the buttons are
 * drawn by the system at the position set in `tauri.conf.json` (x 22, three buttons about 52 wide)
 * and do not scale with the app's text size.
 */
export const TRAFFIC_LIGHTS_INSET = "92px";

/**
 * Whether the header has to leave room for the window buttons right now. macOS hides them in full
 * screen, and the room goes with them.
 */
export function useTitlebarInset(): boolean {
  const overlay = usesOverlayTitlebar({
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    tauri: typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
  });
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!overlay) {
      return;
    }
    let disposed = false;
    let stop: (() => void) | null = null;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        const current = getCurrentWindow();
        const read = () =>
          current
            .isFullscreen()
            .then((value) => !disposed && setFullscreen(value === true))
            .catch(() => undefined);
        await read();
        const unlisten = await current.onResized(() => void read());
        if (disposed) {
          unlisten();
        } else {
          stop = unlisten;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, [overlay]);

  return overlay && !fullscreen;
}
