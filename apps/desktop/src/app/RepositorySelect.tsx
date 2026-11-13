import type { RepoChanges } from "../lib/insights";
import type { Repository, RepositoryId } from "../lib/workspace";
import { Chip } from "../ui/Chip";
import { QuietSelect } from "../ui/QuietSelect";
import { repositoryOptionLabel, unreviewedElsewhere } from "./workspaceView";

/**
 * Which repository of the workspace is in focus. It is the one control for it: the header and the
 * Code sidebar both show it, so the branch, the terminal and the files never disagree about where
 * you are. Each option says what the agent changed there, in words, and a count tells when there
 * is something unreviewed in a repository you are not looking at.
 */
export function RepositorySelect({
  repositories,
  value,
  changes,
  className = "",
  compact = false,
  disabled = false,
  onChange,
}: {
  repositories: readonly Repository[];
  value: RepositoryId | null;
  changes: readonly RepoChanges[];
  className?: string;
  /** The header's wording: a short count instead of a sentence. */
  compact?: boolean;
  disabled?: boolean;
  onChange: (id: RepositoryId) => void;
}) {
  const elsewhere = unreviewedElsewhere(changes, value);
  const note = `${elsewhere} unreviewed ${elsewhere === 1 ? "file" : "files"} in the other repositories of this workspace`;
  return (
    <span className={compact ? "inline-flex min-w-0 items-center gap-2" : "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"}>
      <QuietSelect
        aria-label="Repository"
        className={className}
        disabled={disabled}
        options={repositories.map((repository) => ({
          value: repository.id,
          label: repositoryOptionLabel(
            repository.name,
            changes.find((item) => item.repositoryId === repository.id),
          ),
          display: repository.name,
          hint: repository.root,
        }))}
        sound
        title="The repository you are looking at. The chat and its agent keep seeing all of them."
        value={value ?? ""}
        onChange={onChange}
      />
      {elsewhere > 0 ? (
        <Chip title={note} tone="attention">
          {compact ? (
            <>
              <span aria-hidden="true">+{elsewhere}</span>
              <span className="sr-only">{note}</span>
            </>
          ) : (
            `${elsewhere} unreviewed elsewhere`
          )}
        </Chip>
      ) : null}
    </span>
  );
}
