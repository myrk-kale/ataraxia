import { invoke } from "@tauri-apps/api/core";

/** What the microphone button needs to know about turning speech into text on this computer. */
export type SpeechStatus = {
  ready: boolean;
  /** The engine that will listen: `whisper.cpp`, `mlx-whisper`, `whisper` or `your command`. */
  engine: string | null;
  /** Why nothing can listen, and what to install. */
  problem: string | null;
  command: string;
  model: string;
  model_url: string;
};

export const speechStatus = () => invoke<SpeechStatus>("speech_status");
/** Saves the command and model file the person chose (empty finds one by itself). */
export const speechSet = (command: string, model: string) => invoke<SpeechStatus>("speech_set", { command, model });
/** A WAV recording (base64) to text. */
export const speechTranscribe = (wav: string) => invoke<string>("speech_transcribe", { wav });
