import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import type { ProviderKind } from "./workspace";

/** One way of starting a harness, usually one account. */
export type HarnessProfile = {
  /** Empty until it has been saved. */
  id: string;
  provider: ProviderKind;
  name: string;
  /** `#rrggbb`: the glow behind the harness's mark. */
  color: string;
  /** What starts the harness, as typed in a terminal. */
  command: string;
};

export type Profiles = {
  profiles: HarnessProfile[];
  /** Harness to the id of the profile it starts with; a harness not listed starts the default way. */
  active: Record<string, string>;
};

export type ProfileCheck = { ok: boolean; message: string };

/** Colours to choose from, apart enough to tell two accounts at a glance. */
export const PROFILE_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
] as const;

/** The first colour no profile of this harness uses yet (the list wraps around when all are). */
export function nextColor(taken: readonly string[]): string {
  const used = new Set(taken.map((color) => color.toLowerCase()));
  return PROFILE_COLORS.find((color) => !used.has(color)) ?? PROFILE_COLORS[taken.length % PROFILE_COLORS.length]!;
}

export function profilesOf(all: Profiles, provider: ProviderKind): HarnessProfile[] {
  return all.profiles.filter((profile) => profile.provider === provider);
}

/** The profile a harness starts with now; `null` is the default way. */
export function activeProfile(all: Profiles, provider: ProviderKind): HarnessProfile | null {
  const id = all.active[provider];
  return (id && profilesOf(all, provider).find((profile) => profile.id === id)) || null;
}

const EMPTY: Profiles = { profiles: [], active: {} };

// One copy for the whole window: the settings and every chat show the same thing, and a change
// made in one is seen by the others at once.
let current: Profiles = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: Profiles) {
  current = next;
  loaded = true;
  listeners.forEach((listener) => listener());
}

export async function loadProfiles(): Promise<void> {
  try {
    publish(await invoke<Profiles>("profiles_list"));
  } catch {
    // The profiles are a convenience; without them everything starts the default way.
    loaded = true;
  }
}

export async function saveProfile(profile: HarnessProfile): Promise<void> {
  publish(await invoke<Profiles>("profile_save", { profile }));
}

export async function deleteProfile(id: string): Promise<void> {
  publish(await invoke<Profiles>("profile_delete", { id }));
}

/** Chooses what a harness starts with (`null`: the default). Running chats switch at their next message. */
export async function setActiveProfile(provider: ProviderKind, id: string | null): Promise<void> {
  publish(await invoke<Profiles>("profile_set_active", { provider, id }));
}

export function checkProfile(command: string) {
  return invoke<ProfileCheck>("profile_check", { command });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every profile and which is active, read once from the app and kept up to date. */
export function useProfiles(): Profiles {
  useEffect(() => {
    if (!loaded) {
      void loadProfiles();
    }
  }, []);
  return useSyncExternalStore(subscribe, () => current);
}

/** The profile the harness starts with now, or `null` for the default way. */
export function useActiveProfile(provider: ProviderKind): HarnessProfile | null {
  return activeProfile(useProfiles(), provider);
}
