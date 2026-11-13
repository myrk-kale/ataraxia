export type SpaceId = "chat" | "code" | "decisions" | "flow";

/** Chat and Code are workspaces; Decisions and Flow are artifacts of the chat session. */
export type SpaceGroup = "workspace" | "artifact";

export const SPACES: readonly {
  id: SpaceId;
  label: string;
  group: SpaceGroup;
}[] = [
  {
    id: "chat",
    group: "workspace",
    label: "Chat",
  },
  {
    id: "code",
    group: "workspace",
    label: "Code",
  },
  {
    id: "decisions",
    group: "artifact",
    label: "Decisions",
  },
  {
    id: "flow",
    group: "artifact",
    label: "Flow",
  },
] as const;

export function nextSpace(current: SpaceId, delta: -1 | 1): SpaceId {
  const index = SPACES.findIndex((space) => space.id === current);
  const length = SPACES.length;
  const next = (index + delta + length) % length;
  return SPACES[next]!.id;
}

export { isTypingTarget } from "./shortcuts";
