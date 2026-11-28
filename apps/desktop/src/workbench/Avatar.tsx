import { Loader2, Check, CircleAlert, UserRound, X } from "lucide-react";
import type { MemberView } from "../lib/workbench";
import { initialOf, statusOf, type Tone } from "./model";

/** An agent's initial on a tint of its own, so it is told apart by more than its name. */
export function Avatar({ name, tint, size = 24 }: { name: string; tint: number | null; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className={`grid flex-none place-items-center rounded-cg-sm font-semibold ${tint ? "" : "bg-cg-tint text-cg-muted-strong"}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        ...(tint ? { background: `var(--cg-agent-${tint}-bg)`, color: `var(--cg-agent-${tint}-fg)` } : {}),
      }}
    >
      {initialOf(name)}
    </span>
  );
}

/** The developer on the board: the near-black of the primary action, the colour of their word. */
export function DeveloperMark({ size = 24 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid flex-none place-items-center rounded-cg-sm bg-cg-primary text-cg-on-primary"
      style={{ width: size, height: size }}
    >
      <UserRound size={Math.round(size * 0.6)} />
    </span>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  working: "text-cg-muted-strong",
  needs: "text-cg-amber-text",
  idle: "text-cg-muted",
  done: "text-cg-green",
  bad: "text-cg-red",
};

/** What an agent is doing: an icon and a word, never the colour alone. */
export function Status({ member }: { member: Pick<MemberView, "status" | "finished"> }) {
  const { word, tone } = statusOf(member);
  return (
    <span className={`inline-flex flex-none items-center gap-1 text-small font-medium ${TONE_CLASS[tone]}`}>
      {tone === "working" ? <Loader2 aria-hidden="true" className="animate-spin" size={12} /> : null}
      {tone === "needs" ? <CircleAlert aria-hidden="true" size={12} /> : null}
      {tone === "done" ? <Check aria-hidden="true" size={12} /> : null}
      {tone === "bad" ? <X aria-hidden="true" size={12} /> : null}
      {tone === "idle" ? <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-cg-control" /> : null}
      {word}
    </span>
  );
}
