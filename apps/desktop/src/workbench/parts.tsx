import { CircleCheck, CircleHelp, FileCode, Lock, Megaphone, MessageSquare, Signpost } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Anchor, EntryKind, EntryView, MemberView, Resolution } from "../lib/workbench";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Avatar, DeveloperMark } from "./Avatar";
import { anchorText, KIND_LABEL, tintOf } from "./model";

/** What the screen does with an entry; the container wires these to the app. */
export type EntryActions = {
  onOpenFile: (path: string, line: number | null, endLine: number | null) => void;
  onReply: (entryId: string, text: string) => Promise<void>;
  onResolve: (entryId: string, resolution: Resolution) => Promise<void>;
  onPickTopic: (topic: string) => void;
};

const KIND_ICON: Record<EntryKind, ReactNode> = {
  decision: <Signpost aria-hidden="true" size={12} />,
  claim: <Lock aria-hidden="true" size={12} />,
  question: <CircleHelp aria-hidden="true" size={12} />,
  done: <CircleCheck aria-hidden="true" size={12} />,
  note: <MessageSquare aria-hidden="true" size={12} />,
  directive: <Megaphone aria-hidden="true" size={12} />,
};

/** The kind of an entry as an icon and a word. */
export function KindTag({ kind }: { kind: EntryKind }) {
  return <Chip icon={KIND_ICON[kind]}>{KIND_LABEL[kind]}</Chip>;
}

/** A topic key, in the mono face. With `onPick` it narrows the board to that topic. */
export function TopicChip({ topic, onPick }: { topic: string; onPick?: (topic: string) => void }) {
  const className = "inline-flex min-w-0 max-w-full items-center rounded-cg-sm bg-cg-tint px-1.5 py-0.5 font-mono text-small text-cg-ink";
  if (!onPick) {
    return (
      <span className={className}>
        <span className="truncate">{topic}</span>
      </span>
    );
  }
  return (
    <button className={`${className} hover:bg-cg-line`} title={`Show only “${topic}”`} type="button" onClick={() => onPick(topic)}>
      <span className="truncate">{topic}</span>
    </button>
  );
}

/** Where in the code an entry is, as a button that opens it in Code. */
export function AnchorChip({
  anchor,
  onOpenFile,
}: {
  anchor: Anchor;
  onOpenFile: EntryActions["onOpenFile"];
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button
        className="inline-flex max-w-full items-center gap-1 rounded-cg-sm border border-cg-line px-1.5 py-0.5 font-mono text-small text-cg-ink hover:bg-cg-tint"
        title="Open in Code"
        type="button"
        onClick={() => onOpenFile(anchor.path, anchor.startLine, anchor.endLine)}
      >
        <FileCode aria-hidden="true" className="flex-none" size={12} />
        <span className="truncate">{anchorText(anchor)}</span>
      </button>
      {anchor.rev ? (
        <span className="font-mono text-small text-cg-muted" title="Where to read it as it was written">
          {anchor.rev}
        </span>
      ) : null}
    </span>
  );
}

/** Paths a claim holds or an entry is about. */
export function PathChips({ paths }: { paths: readonly string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {paths.map((path) => (
        <span key={path} className="inline-flex max-w-full items-center gap-1 rounded-cg-sm bg-cg-tint px-1.5 py-0.5 font-mono text-small text-cg-muted-strong">
          <Lock aria-hidden="true" className="flex-none" size={10} />
          <span className="truncate">{path}</span>
        </span>
      ))}
    </span>
  );
}

/** Who wrote an entry: the agent's initial on its tint, or the developer's mark. */
export function Author({ entry, members, size = 24 }: { entry: Pick<EntryView, "author" | "authorLabel">; members: readonly MemberView[]; size?: number }) {
  return entry.author === null ? <DeveloperMark size={size} /> : <Avatar name={entry.authorLabel} size={size} tint={tintOf(entry.author, members)} />;
}

/** A field to answer in: Enter sends, Shift+Enter breaks the line, Esc closes it. */
export function ReplyBox({
  label,
  placeholder,
  submit,
  onSend,
  onCancel,
}: {
  label: string;
  placeholder: string;
  submit: string;
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);

  async function send() {
    const clean = text.trim();
    if (!clean || sending) {
      return;
    }
    setSending(true);
    try {
      await onSend(clean);
    } catch {
      // The screen has told the developer why; what was typed stays, to be sent again.
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="mt-2 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        ref={field}
        aria-label={label}
        className="min-h-[64px] w-full resize-y rounded-cg-md border border-cg-control bg-cg-panel px-3 py-2 text-ui leading-6 text-cg-ink placeholder:text-cg-muted focus:border-cg-ink"
        maxLength={1500}
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!text.trim() || sending} size="sm" type="submit" variant="primary">
          {submit}
        </Button>
      </div>
    </form>
  );
}
