import { invoke } from "@tauri-apps/api/core";

/** What the app keeps on while an agent works or something waits: nothing, the computer, or the computer and its screen. */
export type WakeMode = "off" | "system" | "display";

export const WAKE_OPTIONS: { value: WakeMode; label: string }[] = [
  { value: "display", label: "Computer and screen" },
  { value: "system", label: "Computer only" },
  { value: "off", label: "Nothing" },
];

export function wakeMode(): Promise<WakeMode> {
  return invoke<WakeMode>("wake_mode");
}

export function wakeSetMode(mode: WakeMode): Promise<WakeMode> {
  return invoke<WakeMode>("wake_set_mode", { mode });
}
