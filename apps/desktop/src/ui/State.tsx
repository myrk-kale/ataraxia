import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

/**
 * What a screen shows while it has nothing to show yet. The three cases read differently on
 * purpose: loading says what is loading, empty says why and what fills it, and failed says
 * what went wrong and gives a way to try again.
 */
export function StateMessage({
  title,
  text,
  tone = "empty",
  children,
}: {
  title?: string;
  text: string;
  tone?: "empty" | "loading" | "failed";
  children?: ReactNode;
}) {
  return (
    <section
      aria-live={tone === "empty" ? undefined : "polite"}
      className="mx-auto mt-[16vh] flex max-w-[560px] flex-col items-center gap-3 px-8.5 text-center"
      role={tone === "failed" ? "alert" : undefined}
    >
      {title ? <h1 className="text-small font-semibold text-cg-muted-strong">{title}</h1> : null}
      <p className="flex items-center gap-2 text-heading leading-7 text-cg-ink">
        {tone === "loading" ? <Loader2 aria-hidden="true" className="flex-none animate-spin text-cg-muted-strong" size={16} /> : null}
        <span>{text}</span>
      </p>
      {children}
    </section>
  );
}

/** A short in-place loading line for panels that already have a frame. */
export function Loading({ text }: { text: string }) {
  return (
    <p aria-live="polite" className="flex items-center gap-2 px-4 py-6 text-small text-cg-muted-strong" role="status">
      <Loader2 aria-hidden="true" className="flex-none animate-spin" size={13} />
      {text}
    </p>
  );
}

export type LoadState = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; message: string };

export const LOADING: LoadState = { kind: "loading" };
export const READY: LoadState = { kind: "ready" };
