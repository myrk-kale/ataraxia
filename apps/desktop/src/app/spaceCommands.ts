import type { BtwContextItem } from "../lib/insights";

/** What the shell can ask the space on screen to do for a shortcut. */
export type SpaceCommands = {
  version?: () => void;
  item?: (delta: -1 | 1) => void;
  comment?: () => void;
};

/** Shared with the shell without re-rendering it on every selection change. */
export type SpaceBridge = {
  commands: SpaceCommands;
  /** What the user is looking at, read when BTW opens. */
  context: BtwContextItem | null;
};

export function newBridge(): SpaceBridge {
  return { commands: {}, context: null };
}
