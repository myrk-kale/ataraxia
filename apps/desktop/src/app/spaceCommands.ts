import type { BtwContextItem } from "../lib/insights";

/** What the shell can ask the space on screen to do for a shortcut. */
export type SpaceCommands = {
  version?: () => void;
  item?: (delta: -1 | 1) => void;
  comment?: () => void;
  wrap?: () => void;
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

/** One bridge per space that has something to look at, so BTW knows what each one has open. */
export type SpaceBridges = Record<"code" | "decisions" | "flow", SpaceBridge>;

export function newBridges(): SpaceBridges {
  return { code: newBridge(), decisions: newBridge(), flow: newBridge() };
}

/** What is open in the space the person is in, if it is one that has something to look at. */
export function activeItem(bridges: SpaceBridges, space: string): BtwContextItem | null {
  return space === "code" || space === "decisions" || space === "flow" ? bridges[space].context : null;
}

/** What the other spaces have open (the file, the decision, the diagram), for BTW from anywhere. */
export function otherItems(bridges: SpaceBridges, space: string): BtwContextItem[] {
  return (["code", "decisions", "flow"] as const)
    .filter((id) => id !== space)
    .map((id) => bridges[id].context)
    .filter((item): item is BtwContextItem => item !== null);
}
