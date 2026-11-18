import { GitCompareArrows } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { codeRefs, type GitRefs } from "../lib/insights";
import type { RepositoryId, SessionId } from "../lib/workspace";
import { QuietSelect, type SelectOption } from "../ui/QuietSelect";

/** The default reference: what is pending in the working tree against the branch's last commit. */
export const LAST_COMMIT = "";

/** How many of the current branch's commits are offered. */
const MAX_COMMITS = 25;

/**
 * What the current branch can be compared against. `last commit` comes first and is the default;
 * then the commits of the current branch, newest first, each with its message; then every other
 * branch, remote branch and tag. The branch you are on is left out (it would compare with
 * itself), unless it is the value that is already chosen. There is no "nothing" to pick: the
 * review always shows something against something.
 */
export function referenceOptions(refs: GitRefs | null, current: string, chosen: string): SelectOption[] {
  const list = (kind: "branch" | "remote" | "tag", label: string): SelectOption[] =>
    (refs?.refs ?? [])
      .filter((item) => item.kind === kind && item.name !== current)
      .map((item) => ({ value: item.name, label: item.name, display: `vs ${item.name}`, hint: `${label} · ${item.subject}` }));
  // The first commit is HEAD itself, which `last commit` already stands for.
  const commits: SelectOption[] = (refs?.commits ?? []).slice(1, MAX_COMMITS + 1).map((commit) => ({
    value: commit.rev,
    label: `${commit.short}  ${commit.subject}`.slice(0, 80),
    display: `vs ${commit.short}`,
    hint: current ? `commit on ${current}` : "commit",
  }));
  const head = refs?.commits?.[0];
  const options: SelectOption[] = [
    {
      value: LAST_COMMIT,
      label: head ? `last commit  ${head.short}  ${head.subject}`.slice(0, 80) : "last commit",
      display: "vs last commit",
      hint: "what is pending in the working tree",
    },
    ...commits,
    ...list("branch", "branch"),
    ...list("remote", "remote"),
    ...list("tag", "tag"),
  ];
  if (chosen && !options.some((option) => option.value === chosen)) {
    options.splice(1, 0, { value: chosen, label: chosen, display: `vs ${/^[0-9a-f]{12,40}$/.test(chosen) ? chosen.slice(0, 7) : chosen}` });
  }
  return options;
}

/**
 * The reference the current branch is compared against, chosen inside the code review. Choosing
 * one is all it does: Code then shows the current branch against it.
 */
export function ReferenceSelect({
  sessionId,
  repositoryId = null,
  currentBranch,
  value,
  className = "max-w-[190px] text-ui font-medium text-cg-muted-strong",
  onChange,
}: {
  sessionId: SessionId | null;
  /** The repository in focus: its branches and commits are the ones listed. */
  repositoryId?: RepositoryId | null;
  currentBranch: string;
  value: string;
  className?: string;
  onChange: (value: string) => void;
}) {
  const [refs, setRefs] = useState<GitRefs | null>(null);
  const read = useCallback(() => {
    if (!sessionId) {
      setRefs(null);
      return;
    }
    codeRefs(sessionId, repositoryId)
      .then(setRefs)
      .catch(() => setRefs(null));
  }, [sessionId, repositoryId]);

  // The list is read again whenever the branch changes, and each time the selector opens.
  useEffect(() => {
    read();
  }, [read, currentBranch]);

  const options = useMemo(() => referenceOptions(refs, currentBranch, value), [refs, currentBranch, value]);

  return (
    <QuietSelect
      aria-label="Compare with"
      className={className}
      disabled={!sessionId}
      icon={<GitCompareArrows aria-hidden="true" size={13} />}
      options={options}
      searchable
      title={
        sessionId
          ? "What the review compares against: the last commit (the default), a commit of this branch, another branch or a tag"
          : "Open a chat to compare this branch with another one."
      }
      value={value}
      onChange={onChange}
      onOpen={read}
    />
  );
}
