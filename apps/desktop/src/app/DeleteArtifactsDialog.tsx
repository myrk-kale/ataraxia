import { useEffect, useState } from "react";
import { artifactsDeleteAll } from "../lib/insights";
import { errorText } from "../lib/useInsightEvents";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Overlay";

/**
 * Deleting everything derived from a chat cannot be undone, so, as when deleting a repository on
 * GitHub, the name of the thing has to be typed back before the button works.
 */
export function DeleteArtifactsDialog({
  isOpen,
  sessionId,
  title,
  counts,
  onClose,
  onDeleted,
}: {
  isOpen: boolean;
  sessionId: string;
  title: string;
  counts: { checkpoints: number; decisions: number; diagrams: number };
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setTyped("");
      setProblem(null);
    }
  }, [isOpen]);

  const matches = typed === title;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  async function remove() {
    if (!matches || busy) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await artifactsDeleteAll(sessionId, typed);
      onDeleted();
      onClose();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog isOpen={isOpen} label="Delete all artifacts" size="md" onClose={onClose}>
      <form
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void remove();
        }}
      >
        <h2 className="text-heading font-semibold text-cg-ink">Delete all artifacts of this chat</h2>
        <p className="text-ui leading-6 text-cg-ink">
          This permanently deletes {plural(counts.checkpoints, "checkpoint", "checkpoints")} and everything recorded on
          them: the review queues, {plural(counts.decisions, "decision", "decisions")} with their threads and linked
          commits, {plural(counts.diagrams, "diagram", "diagrams")}, and the review marks, comments and priorities.
        </p>
        <p className="text-ui leading-6 text-cg-muted-strong">
          The chat, your code and git are not touched. This cannot be undone.
        </p>
        <label className="flex flex-col gap-1.5 text-ui text-cg-ink">
          <span>
            To confirm, type <strong className="font-mono font-semibold">{title}</strong>
          </span>
          <input
            autoComplete="off"
            autoFocus
            className="w-full rounded-cg-md border border-cg-control bg-cg-panel px-3 py-1.5 font-mono text-ui text-cg-ink focus:border-cg-ink"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        {problem ? (
          <p className="text-small text-cg-red" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!matches || busy} type="submit" variant="danger">
            {busy ? "Deleting…" : "I understand, delete all artifacts"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
