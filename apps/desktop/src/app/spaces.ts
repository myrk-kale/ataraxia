export type SpaceId = "chat" | "code" | "flow";

/** Chat and Code are workspaces; Flow is an artifact of the chat session. Tasks and Decisions are
 * panels over the chat, not spaces: Tasks slides in from the side (Ctrl/Cmd T), Decisions opens
 * full screen from the chat's own card. */
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
