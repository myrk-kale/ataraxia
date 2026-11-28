import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { ProviderMark } from "../chat/ProviderMark";
import type { ChatSession, Worktree } from "../lib/workspace";
import { Button } from "../ui/Button";
import { candidatesOf } from "./AgentRail";

const WORKTREE_COMMAND = "git worktree add ../my-feature -b feat/my-feature";

/**
 * What the screen says while no chat is on the board: what the board is for, which chats can join
 * (one press each), and how to give each agent a worktree of its own, which is what keeps them from
 * overwriting each other.
 */
export function EmptyBoard({
  chats,
  worktrees,
  onJoin,
}: {
  chats: readonly ChatSession[];
  worktrees: readonly Worktree[];
  onJoin: (sessionId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const candidates = candidatesOf(chats, [], worktrees);

  async function copy() {
    try {
      await navigator.clipboard.writeText(WORKTREE_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // The command is on screen to be typed.
    }
  }

  return (
    <section aria-label="Workbench" className="mx-auto flex w-full max-w-[600px] flex-col gap-6 px-8 pt-[10vh] pb-10">
      <div className="flex flex-col gap-2">
        <h1 className="text-title font-semibold tracking-[-0.3px] text-cg-ink">Put agents on the workbench</h1>
        <p className="text-body leading-7 text-cg-muted-strong">
          Agents working side by side in their own worktrees post here what they decide, what they are about to change and what they
          finish, and read what the others did. You see who touches which file, you answer what they ask, and what you write wins.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-small font-semibold text-cg-muted-strong">Chats of this workspace</h2>
        {candidates.length === 0 ? (
          <p className="text-ui leading-6 text-cg-muted">
            There is no chat here yet. Start one on its own worktree, then come back to add it.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {candidates.map(({ chat, branch }) => (
              <li key={chat.id} className="flex items-center gap-3 rounded-cg-md border border-cg-line px-3 py-2.5">
                <ProviderMark provider={chat.provider} size={18} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-semibold text-cg-ink">{chat.title || "Untitled chat"}</span>
                  {branch ? <span className="block truncate font-mono text-small text-cg-muted">{branch}</span> : null}
                </span>
                <Button size="sm" variant="secondary" onClick={() => onJoin(chat.id)}>
                  Add to the board
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-cg-md bg-cg-tint px-4 py-3.5">
        <h2 className="text-small font-semibold text-cg-muted-strong">One worktree per agent</h2>
        <p className="text-ui leading-6 text-cg-muted-strong">
          Give each agent a worktree of its own and open a chat on it. They cannot overwrite each other, and the board tells you when
          two of them change the same lines.
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-cg-sm bg-cg-panel px-2.5 py-1.5 font-mono text-small text-cg-ink">{WORKTREE_COMMAND}</code>
          <Button size="sm" variant="quiet" onClick={() => void copy()}>
            {copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
    </section>
  );
}
