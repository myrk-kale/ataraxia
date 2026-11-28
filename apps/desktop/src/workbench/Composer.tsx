import { Send, Signpost, Users } from "lucide-react";
import { useState } from "react";
import type { MemberView } from "../lib/workbench";
import { Button } from "../ui/Button";
import { QuietSelect } from "../ui/QuietSelect";

/**
 * The developer's word to the agents. It goes to every agent on the board or to one, and every
 * agent reads it with its next message; the developer's word wins over what the agents decided. With a
 * topic it becomes the decision on that topic, and what the agents decided there is set aside.
 */
export function Composer({
  members,
  to,
  onSend,
}: {
  members: readonly MemberView[];
  /** A chat to address, set by pressing an agent's card; `null` is everyone. */
  to: string | null;
  onSend: (text: string, to: string | null, topic: string | null) => Promise<void>;
}) {
  const [text, setText] = useState("");
  // `undefined`: nothing chosen here, so the card pressed in the rail is who is addressed.
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [asDecision, setAsDecision] = useState(false);
  const [topic, setTopic] = useState("");
  const [sending, setSending] = useState(false);
  const addressed = target === undefined ? to : target;
  const ready = text.trim().length > 0 && (!asDecision || topic.trim().length > 0) && members.length > 0;

  async function send() {
    if (!ready || sending) {
      return;
    }
    setSending(true);
    try {
      await onSend(text.trim(), addressed, asDecision ? topic.trim() : null);
      setText("");
      setTopic("");
      setAsDecision(false);
      setTarget(undefined);
    } catch {
      // The screen has told the developer; what was typed stays to be sent again.
    } finally {
      setSending(false);
    }
  }

  const rows = Math.min(5, Math.max(1, text.split("\n").length));
  return (
    <form
      className="border-t border-cg-line bg-cg-panel px-6 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="mx-auto flex max-w-[880px] flex-col gap-2 rounded-cg-lg border border-cg-line-strong bg-cg-panel p-2.5 focus-within:border-cg-ink">
        <textarea
          aria-label="Tell the agents"
          className="w-full resize-none border-0 bg-transparent px-1.5 py-1 text-body leading-6 text-cg-ink outline-none placeholder:text-cg-muted"
          maxLength={1500}
          placeholder={
            members.length === 0
              ? "Add an agent first. What you write here is read by every agent on the board."
              : asDecision
                ? "The decision, in a sentence. It replaces what the agents decided on this topic."
                : "Tell the agents something they must all know or do…"
          }
          rows={rows}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <QuietSelect
            aria-label="Send to"
            icon={<Users aria-hidden="true" size={13} />}
            options={[{ value: "", label: "Everyone" }, ...members.map((member) => ({ value: member.sessionId, label: member.title }))]}
            value={addressed ?? ""}
            variant="chip"
            onChange={(value) => setTarget(value || null)}
          />
          <button
            aria-pressed={asDecision}
            className="inline-flex items-center gap-1.5 rounded-cg-md border border-cg-line px-2.5 py-1 text-small text-cg-muted-strong hover:border-cg-line-strong hover:text-cg-ink aria-pressed:border-cg-line-strong aria-pressed:bg-cg-tint aria-pressed:text-cg-ink"
            title="Make it the decision on a topic, so no agent decides it another way"
            type="button"
            onClick={() => setAsDecision((on) => !on)}
          >
            <Signpost aria-hidden="true" size={13} />
            Decide a topic
          </button>
          {asDecision ? (
            <input
              aria-label="Topic"
              className="w-44 rounded-cg-md border border-cg-control bg-cg-panel px-2.5 py-1 font-mono text-small text-cg-ink placeholder:text-cg-muted focus:border-cg-ink"
              maxLength={80}
              placeholder="lib:validation"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
            />
          ) : null}
          <span className="ml-auto text-small text-cg-muted">Enter sends, Shift+Enter breaks the line</span>
          <Button disabled={!ready || sending} size="sm" type="submit" variant="primary">
            <Send aria-hidden="true" size={13} />
            Tell {addressed ? "one agent" : "everyone"}
          </Button>
        </div>
      </div>
    </form>
  );
}
