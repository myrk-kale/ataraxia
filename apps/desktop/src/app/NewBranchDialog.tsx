import { useEffect, useMemo, useState } from "react";
import { codeRefs, type GitRefs } from "../lib/insights";
import type { RepositoryId, SessionId } from "../lib/workspace";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Overlay";
import { QuietSelect, type SelectOption } from "../ui/QuietSelect";

function problemText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What a new branch can start from: the branch you are on first, then the other branches, the
 * remote ones, tags and the latest commits. Without a chat to read them through, the branches the
 * selector already knows.
 */
export function baseOptions(
  refs: GitRefs | null,
  current: string,
  local: readonly string[],
  remote: readonly string[],
): SelectOption[] {
  const options: SelectOption[] = [];
  const seen = new Set<string>();
  const add = (option: SelectOption) => {
    if (!seen.has(option.value)) {
      seen.add(option.value);
      options.push(option);
    }
  };
  if (current) {
    add({ value: current, label: current, hint: "current branch" });
  }
  if (refs) {
    for (const [kind, label] of [["branch", "branch"], ["remote", "remote"], ["tag", "tag"]] as const) {
      for (const item of refs.refs.filter((entry) => entry.kind === kind)) {
        add({ value: item.name, label: item.name, hint: `${label} · ${item.subject}` });
      }
    }
    for (const commit of refs.commits.slice(0, 25)) {
      add({ value: commit.rev, label: `${commit.short}  ${commit.subject}`.slice(0, 70), hint: "commit" });
    }
  } else {
    local.forEach((name) => add({ value: name, label: name, hint: "branch" }));
    remote.forEach((name) => add({ value: name, label: name, hint: "remote" }));
  }
  return options;
}

/**
 * Makes a branch and moves to it. It asks for a name and for what the branch starts from: another
 * branch, a remote branch, a tag or a commit, picked from the list or typed.
 */
export function NewBranchDialog({
  isOpen,
  sessionId,
  repositoryId,
  currentBranch,
  localBranches,
  remoteBranches,
  onClose,
  onCreate,
}: {
  isOpen: boolean;
  sessionId: SessionId | null;
  repositoryId: RepositoryId | null;
  currentBranch: string;
  localBranches: readonly string[];
  remoteBranches: readonly string[];
  onClose: () => void;
  /** Resolves once the branch exists and is checked out; a rejection says why it could not be. */
  onCreate: (name: string, base: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [base, setBase] = useState(currentBranch);
  const [typed, setTyped] = useState("");
  const [refs, setRefs] = useState<GitRefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setName("");
    setBase(currentBranch);
    setTyped("");
    setProblem(null);
    setBusy(false);
    setRefs(null);
    if (!sessionId) {
      return;
    }
    let live = true;
    codeRefs(sessionId, repositoryId)
      .then((found) => live && setRefs(found))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [isOpen, sessionId, repositoryId, currentBranch]);

  const options = useMemo(
    () => baseOptions(refs, currentBranch, localBranches, remoteBranches),
    [refs, currentBranch, localBranches, remoteBranches],
  );
  const start = typed.trim() || base;
  const ready = name.trim() !== "" && start !== "" && !busy;

  async function submit() {
    if (!ready) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onCreate(name.trim(), start);
      onClose();
    } catch (err) {
      setProblem(problemText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog isOpen={isOpen} label="New branch" size="md" onClose={onClose}>
      <form
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-heading font-semibold text-cg-ink">New branch</h2>
        <label className="flex flex-col gap-1.5 text-ui text-cg-ink">
          <span>Name</span>
          <input
            autoComplete="off"
            autoFocus
            className="w-full rounded-cg-md border border-cg-control bg-cg-panel px-3 py-1.5 text-ui text-cg-ink focus:border-cg-ink"
            maxLength={200}
            placeholder="feature/my-change"
            spellCheck={false}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="flex flex-col gap-1.5 text-ui text-cg-ink">
          <span id="new-branch-base">Start from</span>
          <div className="rounded-cg-md border border-cg-control px-3 py-1">
            <QuietSelect
              aria-label="Start from"
              className="w-full text-ui text-cg-ink"
              disabled={typed.trim() !== ""}
              options={options}
              placeholder="Choose a branch or a commit"
              searchable
              value={base}
              onChange={setBase}
            />
          </div>
        </div>
        <label className="flex flex-col gap-1.5 text-ui text-cg-ink">
          <span>Or another commit, tag or revision</span>
          <input
            autoComplete="off"
            className="w-full rounded-cg-md border border-cg-control bg-cg-panel px-3 py-1.5 font-mono text-ui text-cg-ink focus:border-cg-ink"
            maxLength={200}
            placeholder="a1b2c3d, v1.2.0, HEAD~3"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        <p className="text-small leading-5 text-cg-muted-strong">
          Starting from a remote branch makes the new one track it. The worktree moves to the new branch; local edits
          that would be overwritten stop it, and nothing changes.
        </p>
        {problem ? (
          <p className="text-small text-cg-red" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready} type="submit" variant="primary">
            {busy ? "Creating…" : "Create branch"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
