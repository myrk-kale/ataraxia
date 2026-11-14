import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { writeClipboard, type Copyable } from "./markdownCopy";

type State = "idle" | "copied" | "failed";

/**
 * Sits in the corner of a block the reader may want to take away: a table, a block of code, a
 * diagram. Shown while the pointer is over the block or focus is inside it; it says what happened
 * in words, not only in colour.
 */
export function CopyButton({
  what,
  read,
  inline = false,
  label = "Copy",
}: {
  what: string;
  read: () => Copyable;
  /** Sits in a toolbar the block provides, instead of in the block's corner. */
  inline?: boolean;
  /** The word on the button. */
  label?: string;
}) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );

  async function copy() {
    let next: State = "copied";
    try {
      await writeClipboard(read());
    } catch {
      next = "failed";
    }
    setState(next);
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(() => setState("idle"), 1800);
  }

  return (
    <>
      <button
        aria-label={`Copy ${what}`}
        className={`flex items-center gap-1 rounded-cg-sm border border-cg-line-strong bg-cg-panel px-2 py-1 text-small text-cg-muted-strong hover:text-cg-ink ${
          inline
            ? ""
            : "absolute top-1.5 right-1.5 opacity-0 shadow-sm group-focus-within/copy:opacity-100 group-hover/copy:opacity-100 focus-visible:opacity-100"
        }`}
        type="button"
        onClick={() => {
          void copy();
        }}
      >
        {state === "copied" ? <Check aria-hidden="true" size={12} /> : <Copy aria-hidden="true" size={12} />}
        {state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : label}
      </button>
      <span aria-live="polite" className="sr-only" role="status">
        {state === "copied" ? `Copied ${what}` : state === "failed" ? `Could not copy ${what}` : ""}
      </span>
    </>
  );
}
