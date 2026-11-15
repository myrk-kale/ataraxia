import { Menu } from "@tauri-apps/api/menu";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type MenuEntry, type MenuTools, menuFor } from "./contextMenu";

/** A picture on the clipboard, drawn from the one on the page (so no request is made for it). */
async function copyImage(image: HTMLImageElement): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
  if (blob) {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }
}

function toolsNow(): MenuTools {
  return {
    selection: window.getSelection()?.toString() ?? "",
    copyText: (text) => navigator.clipboard.writeText(text),
    copyImage,
    openLink: (href) => void openUrl(href).catch(() => undefined),
  };
}

function items(entries: MenuEntry[]) {
  return entries.map((entry) => {
    switch (entry.type) {
      case "separator":
        return { item: "Separator" as const };
      case "predefined":
        return { item: entry.item };
      case "action":
        return {
          text: entry.text,
          enabled: entry.enabled ?? true,
          action: () => void Promise.resolve(entry.run()).catch(() => undefined),
        };
    }
  });
}

let open: Menu | null = null;

/**
 * Answers right-clicks with the app's menu instead of the webview's. Outside the desktop app
 * (the browser preview) the browser's own menu is left alone. Returns what undoes it.
 */
export function installContextMenu(): () => void {
  if (!("__TAURI_INTERNALS__" in window)) {
    return () => undefined;
  }
  async function onContextMenu(event: MouseEvent) {
    // Something inside the page (the code editor) already answered.
    if (event.defaultPrevented) {
      return;
    }
    // A way to the webview's inspector while developing.
    if (import.meta.env.DEV && event.shiftKey) {
      return;
    }
    const entries = menuFor(event.target, toolsNow());
    if (entries === null) {
      return;
    }
    event.preventDefault();
    if (entries.length === 0) {
      return;
    }
    try {
      const previous = open;
      open = await Menu.new({ items: items(entries) });
      await open.popup();
      void previous?.close();
    } catch {
      // No menu is better than a broken one.
    }
  }
  document.addEventListener("contextmenu", onContextMenu);
  return () => document.removeEventListener("contextmenu", onContextMenu);
}
