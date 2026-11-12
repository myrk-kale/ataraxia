export type SpaceId = "chat" | "code" | "decisions" | "flow";

/** Chat and Code are workspaces; Decisions and Code flow are artifacts of the chat session. */
export type SpaceGroup = "workspace" | "artifact";

export const SPACES: readonly {
  id: SpaceId;
  label: string;
  group: SpaceGroup;
  blurb: string;
}[] = [
  {
    id: "chat",
    group: "workspace",
    label: "Chat",
    blurb: "Sessão com o agente, ferramentas e artefatos da execução.",
  },
  {
    id: "code",
    group: "workspace",
    label: "Code",
    blurb: "Leitura, edição e revisão do repositório em uma superfície só.",
  },
  {
    id: "decisions",
    group: "artifact",
    label: "Decisions",
    blurb: "Julgamento de escolhas de engenharia, uma decisão por vez.",
  },
  {
    id: "flow",
    group: "artifact",
    label: "Code flow",
    blurb: "Diagramas interativos gerados sob demanda a partir do código.",
  },
] as const;

export function nextSpace(current: SpaceId, delta: -1 | 1): SpaceId {
  const index = SPACES.findIndex((space) => space.id === current);
  const length = SPACES.length;
  const next = (index + delta + length) % length;
  return SPACES[next]!.id;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
