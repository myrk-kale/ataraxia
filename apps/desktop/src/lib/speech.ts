import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SpeechLanguage = { code: string; name: string };

/** A model the built-in engine can listen with. */
export type SpeechModel = { id: string; name: string; megabytes: number; downloaded: boolean };

/** What the microphone button needs to know about turning speech into text on this computer. */
export type SpeechStatus = {
  /** It can listen now. */
  ready: boolean;
  /** `built-in Whisper`, or `your command` when one was set. */
  engine: string | null;
  /** The engine is fast enough to write the text while the person is still speaking. */
  streaming: boolean;
  /** The built-in engine is in use and its model has not been downloaded yet. */
  needs_model: boolean;
  downloading: boolean;
  /** The model in use, and what it weighs. */
  model: string;
  model_megabytes: number;
  model_url: string;
  models: SpeechModel[];
  /** Why it cannot listen, when that is not just the missing model. */
  problem: string | null;
  command: string;
  /** An ISO code, or empty to let Whisper work the language out. */
  language: string;
  languages: SpeechLanguage[];
};

export type DownloadProgress = { received: number; total: number | null };

export const speechStatus = () => invoke<SpeechStatus>("speech_status");
/** Saves the command (empty uses the built-in engine), the language (empty detects it) and the model. */
export const speechSet = (command: string, language: string, model?: string) =>
  invoke<SpeechStatus>("speech_set", { command, language, model });
/** Downloads the speech model; progress arrives through `listenDownload`. Resumes an interrupted download. */
export const speechDownload = () => invoke<SpeechStatus>("speech_download");
export const speechDownloadCancel = () => invoke<void>("speech_download_cancel");
/**
 * A WAV recording (16 kHz mono, base64) to text. `quick` is for a preview of what is still being
 * said: it is answered sooner and is less careful than the text that is kept.
 */
export const speechTranscribe = (wav: string, quick = false) => invoke<string>("speech_transcribe", { wav, quick });
/** Loads the model ahead of the first words, so listening does not begin with a wait. */
export const speechWarmup = () => invoke<void>("speech_warmup");

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
