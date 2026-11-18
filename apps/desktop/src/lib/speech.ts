import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SpeechLanguage = { code: string; name: string };

/** What the microphone button needs to know about turning speech into text on this computer. */
export type SpeechStatus = {
  /** It can listen now. */
  ready: boolean;
  /** `built-in Whisper`, or `your command` when one was set. */
  engine: string | null;
  /** The built-in engine is in use and its model has not been downloaded yet. */
  needs_model: boolean;
  downloading: boolean;
  model_megabytes: number;
  model_url: string;
  /** Why it cannot listen, when that is not just the missing model. */
  problem: string | null;
  command: string;
  /** An ISO code, or empty to let Whisper work the language out. */
  language: string;
  languages: SpeechLanguage[];
};

export type DownloadProgress = { received: number; total: number | null };

export const speechStatus = () => invoke<SpeechStatus>("speech_status");
/** Saves the command (empty uses the built-in engine) and the language (empty detects it). */
export const speechSet = (command: string, language: string) => invoke<SpeechStatus>("speech_set", { command, language });
/** Downloads the speech model; progress arrives through `listenDownload`. Resumes an interrupted download. */
export const speechDownload = () => invoke<SpeechStatus>("speech_download");
export const speechDownloadCancel = () => invoke<void>("speech_download_cancel");
/** A WAV recording (16 kHz mono, base64) to text. */
export const speechTranscribe = (wav: string) => invoke<string>("speech_transcribe", { wav });

export function listenDownload(handler: (progress: DownloadProgress) => void): Promise<UnlistenFn> {
  return listen<DownloadProgress>("speech://download", (event) => handler(event.payload));
}

/** `143 of 574 MB`, or just what has arrived when the total is not known. */
export function progressText(progress: DownloadProgress): string {
  const mb = (bytes: number) => Math.round(bytes / 1_000_000);
  return progress.total ? `${mb(progress.received)} of ${mb(progress.total)} MB` : `${mb(progress.received)} MB`;
}

/** 0 to 100, or `null` when the total is not known. */
export function progressPercent(progress: DownloadProgress): number | null {
  return progress.total ? Math.min(100, Math.floor((progress.received / progress.total) * 100)) : null;
}
