import { FileCode, GitBranch, Lock, LogOut, MessageCircle, Plus } from "lucide-react";
import { useState } from "react";
import { ProviderMark } from "../chat/ProviderMark";
import type { MemberView } from "../lib/workbench";
import type { ChatSession, Worktree } from "../lib/workspace";
import { Button } from "../ui/Button";
import { Tip } from "../ui/Overlay";
import { Avatar, Status } from "./Avatar";
import { statusOf, tintOf } from "./model";

/** The chats of the workspace that are not on the board yet, with the branch each one is on. */
export function candidatesOf(chats: readonly ChatSession[], members: readonly MemberView[], worktrees: readonly Worktree[]) {
  const on = new Set(members.map((member) => member.sessionId));
  return chats
    .filter((chat) => !on.has(chat.id))
    .map((chat) => ({ chat, branch: worktrees.find((worktree) => worktree.id === chat.worktree_id)?.branch ?? null }));
}

/**
 * The agents on the board, one card each: whether it is working, what it said it is doing, what it
 * holds, how much it has changed, and whether it has read what the others posted. A card is also a
 * filter: pressing it narrows the board to that agent.
 */
export function AgentRail({
  members,
  chats,
  worktrees,
  selected,
  onSelect,
  onJoin,
  onLeave,
  onOpenChat,
}: {
  members: readonly MemberView[];
  chats: readonly ChatSession[];
  worktrees: readonly Worktree[];
  selected: string | null;
  onSelect: (sessionId: string | null) => void;
  onJoin: (sessionId: string) => void;
  onLeave: (sessionId: string) => void;
  onOpenChat: (sessionId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const candidates = candidatesOf(chats, members, worktrees);

  return (
    <aside
      aria-label="Agents on the workbench"
      className="flex max-h-[42%] w-full flex-none flex-col border-b border-cg-line bg-cg-sidebar md:max-h-none md:w-[300px] md:border-r md:border-b-0"
    >
      <header className="flex items-baseline justify-between px-4 pt-4 pb-2">
        <h2 className="text-small font-semibold text-cg-muted-strong">Agents</h2>
        <span className="text-small text-cg-muted">{members.length}</span>
      </header>

      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
        {members.map((member) => (
          <MemberCard
            key={member.sessionId}
            member={member}
            members={members}
            selected={selected === member.sessionId}
            onLeave={() => onLeave(member.sessionId)}
            onOpenChat={() => onOpenChat(member.sessionId)}
            onSelect={() => onSelect(selected === member.sessionId ? null : member.sessionId)}
          />
        ))}
      </ul>

      <div className="border-t border-cg-line p-3">
        <button
          aria-expanded={adding}
          className="flex w-full items-center gap-2 rounded-cg-md px-2.5 py-2 text-ui text-cg-muted-strong hover:bg-cg-tint hover:text-cg-ink"
          type="button"
          onClick={() => setAdding((open) => !open)}
        >
          <Plus aria-hidden="true" size={14} />
          Add a chat
          <span className="ml-auto text-small text-cg-muted">{candidates.length}</span>
        </button>
        {adding ? (
          candidates.length === 0 ? (
            <p className="px-2.5 pt-2 text-small leading-5 text-cg-muted">
              {chats.length === 0
                ? "This workspace has no chats yet. Start one on its own worktree, then add it here."
                : "Every chat of this workspace is on the board."}
            </p>
          ) : (
            <ul aria-label="Chats that can join" className="mt-1 flex max-h-56 flex-col gap-0.5 overflow-y-auto">
              {candidates.map(({ chat, branch }) => (
                <li key={chat.id}>
                  <button
                    className="flex w-full items-center gap-2 rounded-cg-sm px-2.5 py-1.5 text-left hover:bg-cg-tint"
                    type="button"
                    onClick={() => {
                      onJoin(chat.id);
                      setAdding(candidates.length > 1);
                    }}
                  >
                    <ProviderMark provider={chat.provider} size={14} />
                    <span className="min-w-0 flex-1 truncate text-ui text-cg-ink">{chat.title || "Untitled chat"}</span>
                    {branch ? <span className="max-w-[40%] truncate font-mono text-small text-cg-muted">{branch}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </aside>
  );
}

function MemberCard({
  member,
  members,
  selected,
  onSelect,
  onOpenChat,
  onLeave,
}: {
  member: MemberView;
  members: readonly MemberView[];
  selected: boolean;
  onSelect: () => void;
  onOpenChat: () => void;
  onLeave: () => void;
}) {
  const tone = statusOf(member).tone;
  const silent = tone === "working" && member.now === null;
  const holds = member.holds.slice(0, 3);
  return (
    <li
      className={`relative rounded-cg-md border transition-colors ${
        selected ? "border-cg-accent bg-cg-accent-bg" : "border-cg-line bg-cg-panel hover:border-cg-line-strong"
      }`}
    >
      <button
        aria-label={`${member.title}: ${selected ? "showing only this agent, press to show everyone" : "show only this agent"}`}
        aria-pressed={selected}
        className="flex w-full flex-col gap-2 rounded-cg-md p-3 pr-[4.25rem] text-left"
        type="button"
        onClick={onSelect}
      >
        <span className="flex items-start gap-2.5">
          <Avatar name={member.title} tint={tintOf(member.sessionId, members)} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="line-clamp-2 text-ui leading-5 font-semibold text-cg-ink">{member.title}</span>
            <Status member={member} />
          </span>
        </span>

        {member.now ? (
          <span className="line-clamp-2 text-ui leading-5 text-cg-ink">{member.now}</span>
        ) : silent ? (
          <span className="text-ui leading-5 text-cg-muted italic">Has not said what it is doing.</span>
        ) : null}

        {holds.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {holds.map((held) => (
              <span
                key={held}
                className="inline-flex max-w-full items-center gap-1 rounded-cg-sm bg-cg-tint px-1.5 py-0.5 font-mono text-small text-cg-muted-strong"
                title={`Holds ${held}`}
              >
                <Lock aria-hidden="true" className="flex-none" size={10} />
                <span className="truncate">{held}</span>
              </span>
            ))}
            {member.holds.length > holds.length ? (
              <span className="px-1 py-0.5 text-small text-cg-muted">+{member.holds.length - holds.length}</span>
            ) : null}
          </span>
        ) : null}

        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-cg-muted">
          {member.branch ? (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1" title={`Branch ${member.branch}`}>
              <GitBranch aria-hidden="true" className="flex-none" size={12} />
              <span className="truncate font-mono">{member.branch}</span>
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1" title="Files changed since it joined the board">
            <FileCode aria-hidden="true" className="flex-none" size={12} />
            {member.filesChanged === 0 ? (
              "No changes yet"
            ) : (
              <>
                {member.filesChanged} {member.filesChanged === 1 ? "file" : "files"}
                <span className="font-mono text-cg-add-fg">+{member.additions}</span>
                <span className="font-mono text-cg-del-fg">−{member.deletions}</span>
              </>
            )}
          </span>
        </span>

        {member.unseen > 0 ? (
          <span
            className="text-small font-medium text-cg-amber-text"
            title="Its agent has not been handed these posts yet. It reads them with its next message, or when it calls workbench_check."
          >
            Has not read {member.unseen} newer {member.unseen === 1 ? "post" : "posts"}
          </span>
        ) : null}
        {member.problem ? (
          <span className="text-small text-cg-amber-text" title={member.problem}>
            Cannot read its worktree
          </span>
        ) : null}
      </button>

      <div className="absolute top-2 right-2 flex items-center">
        <Tip label="Open its chat">
          <Button aria-label={`Open the chat of ${member.title}`} variant="icon" onClick={onOpenChat}>
            <MessageCircle aria-hidden="true" size={14} />
          </Button>
        </Tip>
        <Tip label="Take it off the board. What it holds is released.">
          <Button aria-label={`Take ${member.title} off the workbench`} variant="icon" onClick={onLeave}>
            <LogOut aria-hidden="true" size={14} />
          </Button>
        </Tip>
      </div>
    </li>
  );
}
