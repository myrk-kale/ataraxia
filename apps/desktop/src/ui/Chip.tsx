import type { ReactNode } from "react";

type Tone = "neutral" | "info" | "attention";

const TONES: Record<Tone, string> = {
  neutral: "border-cg-line-strong bg-cg-tint text-cg-muted-strong",
  info: "border-transparent bg-cg-accent-bg text-cg-accent",
  attention: "border-cg-line-strong bg-cg-panel text-cg-amber-text",
};

/**
 * A state of the thing on screen (read-only, edited since, judged by AI). It is words in a box,
 * never a colour alone, so the state survives colour blindness and a monochrome display.
 */
export function Chip({
  tone = "neutral",
  icon,
  title,
  children,
}: {
  tone?: Tone;
  icon?: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex flex-none items-center gap-1 rounded-cg-sm border px-1.5 py-0.5 text-small font-medium ${TONES[tone]}`}
      title={title}
    >
      {icon}
      {children}
    </span>
  );
}
