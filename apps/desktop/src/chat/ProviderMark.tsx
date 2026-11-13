import type { ProviderKind } from "../lib/workspace";

const INITIAL: Record<ProviderKind, string> = {
  claude: "C",
  codex: "X",
  opencode: "O",
  fake: "D",
};

const TONE: Record<ProviderKind, string> = {
  claude: "bg-cg-mark-claude-bg text-cg-mark-claude-fg",
  codex: "bg-cg-mark-codex-bg text-cg-mark-codex-fg",
  opencode: "bg-cg-mark-opencode-bg text-cg-mark-opencode-fg",
  fake: "bg-cg-mark-demo-bg text-cg-mark-demo-fg",
};

/**
 * Tells the agents apart at a glance: an initial on a tint of its own. It is a stand-in until
 * the providers' official marks are cleared for use, and it is decorative: the name is always
 * written next to it.
 */
export function ProviderMark({ provider, size = 20 }: { provider: ProviderKind; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className={`grid flex-none place-items-center rounded-cg-sm font-mono font-semibold ${TONE[provider]}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
    >
      {INITIAL[provider]}
    </span>
  );
}
