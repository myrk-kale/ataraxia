import { GitCompareArrows } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { codeRefs, type GitRefs } from "../lib/insights";
import type { RepositoryId, SessionId } from "../lib/workspace";
import { QuietSelect, type SelectOption } from "../ui/QuietSelect";

const NONE = "";

/**
 * What the current branch can be compared against: any other branch, remote branch, tag or one of
 * the recent commits. The branch you are on is left out (it would compare with itself), unless it
 * is the value that is already chosen.
 */
export function referenceOptions(refs: GitRefs | null, current: string, chosen: string): SelectOption[] {
  const list = (kind: "branch" | "remote" | "tag", label: string): SelectOption[] =>
    (refs?.refs ?? [])
      .filter((item) => item.kind === kind && item.name !== current)
      .map((item) => ({ value: item.name, label: item.name, display: `vs ${item.name}`, hint: `${label} · ${item.subject}` }));
  const commits: SelectOption[] = (refs?.commits ?? []).slice(0, 25).map((commit) => ({
    value: commit.rev,
    label: `${commit.short}  ${commit.subject}`.slice(0, 70),
    display: `vs ${commit.short}`,
    hint: "commit",
  }));
  const options: SelectOption[] = [
    { value: NONE, label: "No comparison", display: "Compare with…", hint: "review what the agent changed, turn by turn" },
    ...list("branch", "branch"),
    ...list("remote", "remote"),
    ...list("tag", "tag"),
    ...commits,
  ];
  if (chosen && !options.some((option) => option.value === chosen)) {
    options.splice(1, 0, { value: chosen, label: chosen, display: `vs ${/^[0-9a-f]{12,40}$/.test(chosen) ? chosen.slice(0, 7) : chosen}` });
  }
  return options;
}

/**
 * The reference the current branch is compared against, chosen right where the branch is chosen.
 * Choosing one is all it does: Code then shows the current branch against it.
 */
export function ReferenceSelect({
  sessionId,
  repositoryId = null,
  currentBranch,
  value,
  onChange,
}: {
  sessionId: SessionId | null;
  /** The repository in focus: its branches and commits are the ones listed. */
  repositoryId?: RepositoryId | null;
  currentBranch: string;
  value: string;
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
      className="max-w-[190px] text-ui font-medium text-cg-muted-strong"
      disabled={!sessionId}
      icon={<GitCompareArrows aria-hidden="true" size={13} />}
      options={options}
      placeholder="Compare with…"
      searchable
      title={
        sessionId
          ? "Compare this branch against another branch or a commit. Code then shows what differs."
          : "Open a chat to compare this branch with another one."
      }
      value={value}
      onChange={onChange}
      onOpen={read}
    />
  );
}
