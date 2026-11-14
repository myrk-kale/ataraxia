import type { PieceModule } from "../vendor/ascii-magic/player.js";

/**
 * Which picture the opening shows. It follows the clock of this computer, so it needs nothing
 * from the network and nothing is sent anywhere.
 */
export type TimeOfDay = "morning" | "afternoon" | "evening" | "night";

export const TIMES_OF_DAY: readonly TimeOfDay[] = ["morning", "afternoon", "evening", "night"];

/** Where each part of the day starts, in minutes after midnight. Night is what is left. */
const MORNING_FROM = 5 * 60;
const AFTERNOON_FROM = 12 * 60;
const EVENING_FROM = 17 * 60 + 30;
const NIGHT_FROM = 21 * 60;

export function timeOfDay(date: Date): TimeOfDay {
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes >= NIGHT_FROM || minutes < MORNING_FROM) {
    return "night";
  }
  if (minutes >= EVENING_FROM) {
    return "evening";
  }
  return minutes >= AFTERNOON_FROM ? "afternoon" : "morning";
}

export interface Scene {
  /** The vendored piece (`vendor/ascii-magic/pieces/<slug>.js`). */
  slug: string;
  /** What it shows, in a few words. */
  label: string;
  /** Loaded when the opening needs it, so the three it does not need cost nothing. */
  load: () => Promise<PieceModule>;
}

const piece = (module: Promise<unknown>) => module as Promise<PieceModule>;

export const SCENES: Record<TimeOfDay, Scene> = {
  morning: {
    slug: "summit-cloud-sea",
    label: "A snowy peak above a sea of cloud at sunrise",
    load: () => piece(import("../vendor/ascii-magic/pieces/summit-cloud-sea.js")),
  },
  afternoon: {
    slug: "tropical-island",
    label: "A small island in a bright sea",
    load: () => piece(import("../vendor/ascii-magic/pieces/tropical-island.js")),
  },
  evening: {
    slug: "savanna-sunset",
    label: "The savanna at sunset",
    load: () => piece(import("../vendor/ascii-magic/pieces/savanna-sunset.js")),
  },
  night: {
    slug: "moonlit-sea",
    label: "The sea under the moon",
    load: () => piece(import("../vendor/ascii-magic/pieces/moonlit-sea.js")),
  },
};

/**
 * A part of the day forced from the address (`?time=night`), for looking at the pictures in
 * development. In a built app there is nothing to force.
 */
export function forcedTime(search: string, development: boolean): TimeOfDay | null {
  if (!development) {
    return null;
  }
  const asked = new URLSearchParams(search).get("time");
  return TIMES_OF_DAY.find((time) => time === asked) ?? null;
}
