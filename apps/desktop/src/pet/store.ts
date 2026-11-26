import { useSyncExternalStore } from "react";
import { DEFAULT_PET, loadPet, savePet, type PetConfig } from "./config";

// One copy for the window: the pet on screen and its settings read the same thing, and a change
// made in one shows in the other at once.
let current: PetConfig | null = null;
const listeners = new Set<() => void>();

function config(): PetConfig {
  current ??= loadPet();
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePet(): PetConfig {
  return useSyncExternalStore(subscribe, config, () => DEFAULT_PET);
}

export function updatePet(patch: Partial<PetConfig>): void {
  current = { ...config(), ...patch };
  savePet(current);
  listeners.forEach((listener) => listener());
}

/** Back to how it starts: its looks, size and corner. `mode` is the person's choice and stays. */
export function resetPet(): void {
  updatePet({ ...DEFAULT_PET, mode: config().mode === "off" ? "pet" : config().mode });
}

/** `/pet`: shows it, or tucks it away. */
export function togglePet(): PetConfig["mode"] {
  const mode = config().mode === "off" ? "pet" : "off";
  updatePet({ mode });
  return mode;
}

/** For tests: forget what is held, so the next read comes from storage. */
export function forgetPetForTests(): void {
  current = null;
  listeners.forEach((listener) => listener());
}
