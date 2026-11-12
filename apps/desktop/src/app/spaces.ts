export type SpaceId = "chat" | "code" | "decisions" | "flow";

export const SPACES: readonly { id: SpaceId; label: string; blurb: string }[] = [
  {
    id: "chat",
    label: "Chat",
    blurb: "Sessão com o agente, ferramentas e artefatos da execução.",
  },
  {
    id: "code",
    label: "Code",
    blurb: "Leitura, edição e revisão do repositório em uma superfície só.",
  },
  {
    id: "decisions",
    label: "Decisions",
    blurb: "Julgamento de escolhas de engenharia, uma decisão por vez.",
  },
  {
    id: "flow",
    label: "Flow",
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
