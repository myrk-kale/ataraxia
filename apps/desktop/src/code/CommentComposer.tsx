import { TextArea } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { Dialog, Key } from "../ui/Overlay";

/** The temporary editor a comment is written in; there is no permanent comment form. */
export function CommentComposer({
  isOpen,
  title,
  placeholder = "Write a note…",
  submitLabel = "Add comment",
  onSubmit,
  onClose,
}: {
  isOpen: boolean;
  title: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (text: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      setText("");
      requestAnimationFrame(() => field.current?.focus());
    }
  }, [isOpen]);

  async function submit() {
    const value = text.trim();
    if (!value || busy) {
      return;
    }
    setBusy(true);
    try {
      await onSubmit(value);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog isOpen={isOpen} label="Comment" size="md" onClose={onClose}>
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="truncate text-small font-medium text-cg-muted-strong">{title}</p>
        <TextArea
          ref={field}
          aria-label="Comment"
          className="min-h-[96px] w-full text-ui"
          fullWidth
          placeholder={placeholder}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 text-small text-cg-muted">
            <Key>Ctrl/⌘</Key>
            <Key>Enter</Key> to send · <Key>Esc</Key> to cancel
          </span>
          <Button disabled={!text.trim() || busy} type="submit" variant="primary">
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
