import { GitBranch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Overlay";
import { parseBranchInput, type BranchTarget } from "./branchLink";

function problemText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function GoToBranchDialog({
  isOpen,
  currentBranch,
  onClose,
  onGo,
}: {
  isOpen: boolean;
  currentBranch: string;
  onClose: () => void;
  /** Resolves once the branch is checked out; a rejection says why it could not be. */
  onGo: (target: BranchTarget) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setText("");
      setBusy(false);
      setProblem(null);
    }
  }, [isOpen]);

  const parsed = useMemo(() => (text.trim() ? parseBranchInput(text) : null), [text]);
  const ready = parsed?.ok === true && !busy;

  async function submit() {
    if (!parsed?.ok || busy) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onGo(parsed.target);
      onClose();
    } catch (err) {
      setProblem(problemText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog isOpen={isOpen} label="Go to branch" size="md" placement="top" onClose={onClose}>
      <form
        className="flex flex-col gap-3 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className="flex items-center gap-2 text-heading font-semibold text-cg-ink">
          <GitBranch aria-hidden="true" size={16} />
          Go to branch
        </h2>
        <input
          aria-describedby="go-to-branch-hint"
          aria-label="Branch name or URL"
          autoComplete="off"
          autoFocus
          className="w-full rounded-cg-md border border-cg-control bg-cg-panel px-3 py-2 text-ui text-cg-ink focus:border-cg-ink"
          placeholder="Branch name or URL"
          readOnly={busy}
          spellCheck={false}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setProblem(null);
          }}
        />
        <p id="go-to-branch-hint" aria-live="polite" className="min-h-5 text-small text-cg-muted-strong">
          {problem ? (
            <span className="text-cg-red" role="alert">
              {problem}
            </span>
          ) : parsed?.ok ? (
            <>
              {busy ? "Switching to " : "Switches to "}
              <code className="font-mono text-cg-ink">{parsed.target.branch}</code>
              {parsed.target.repository ? <> in {parsed.target.repository}</> : null}
              {parsed.target.branch === currentBranch ? " (already on it)" : null}
              {busy ? "…" : ". It is fetched from the remote if it is not here yet."}
            </>
          ) : parsed ? (
            <span className="text-cg-red">{parsed.problem}</span>
          ) : (
            <>
              Paste a branch link from Azure DevOps, GitHub, GitLab, or Bitbucket.
              For HTTP(S) or SSH clone URLs, append <code className="font-mono">#branch</code>.
            </>
          )}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready} type="submit" variant="primary">
            {busy ? "Switching…" : "Go to branch"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
