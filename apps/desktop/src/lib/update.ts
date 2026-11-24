import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A newer release than the one running, as the app found it. */
export type UpdateInfo = { version: string; current: string; notes: string | null };

/** How much of the download is in; `total` is null when the server did not say how big it is. */
export type UpdateProgress = { downloaded: number; total: number | null };

/** The first look waits, so it does not compete with the app opening. */
export const UPDATE_FIRST_CHECK_MS = 15_000;
export const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000;

/** The newer release there is; null when this is the newest, or this copy cannot update itself. */
export function updateCheck(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("update_check");
}

/** Downloads and installs the release found, then restarts the app: it comes back only on failure. */
export function updateInstall(): Promise<void> {
  return invoke<void>("update_install");
}

export function onUpdateProgress(handler: (progress: UpdateProgress) => void): Promise<UnlistenFn> {
  return listen<UpdateProgress>("update://progress", (event) => handler(event.payload));
}

/** Whole percent downloaded, or null when the size is not known. */
export function progressPercent(progress: UpdateProgress): number | null {
  if (!progress.total) {
    return null;
  }
  return Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
}
