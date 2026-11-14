import { Check, Copy, MessageSquarePlus, Sparkles } from "lucide-react";
import { useState } from "react";
import { writeClipboard } from "../chat/markdownCopy";

const BUTTON =
  "flex items-center gap-1.5 rounded-cg-sm px-2 py-1 text-small text-cg-muted-strong hover:bg-cg-tint hover:text-cg-ink";

/**
 * The few things worth doing with some selected code, in a small bar next to it: ask about it (BTW,
 * which is then told the text, the file and the lines), comment on it, or copy it.
 */
export function SelectionMenu({
  text,
  onAsk,
  onComment,
  onDone,
}: {
  text: string;
  onAsk: () => void;
  /** Left out where a comment cannot be attached (a file that is not part of a checkpoint). */
  onComment?: () => void;
  /** Whatever was chosen is finished: the bar can go. */
  onDone: () => void;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await writeClipboard({ text });
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(onDone, 700);
  }

  return (
    <div
      aria-label="Selection actions"
      className="flex items-center gap-0.5 rounded-cg-md border border-cg-line-strong bg-cg-panel p-1 shadow-cg-pop"
      role="toolbar"
    >
      <button
        className={BUTTON}
        title="Ask BTW about this selection (Ctrl/⌘ K)"
        type="button"
        onClick={() => {
          onDone();
          onAsk();
        }}
      >
        <Sparkles aria-hidden="true" size={13} />
        Ask
      </button>
      {onComment ? (
        <button
          className={BUTTON}
          title="Comment on this line (C)"
          type="button"
          onClick={() => {
            onDone();
            onComment();
          }}
        >
          <MessageSquarePlus aria-hidden="true" size={13} />
          Comment
        </button>
      ) : null}
      <button
        className={BUTTON}
        title="Copy the selection"
        type="button"
        onClick={() => {
          void copy();
        }}
      >
        {copied === "copied" ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
        {copied === "copied" ? "Copied" : copied === "failed" ? "Could not copy" : "Copy"}
      </button>
    </div>
  );
}
