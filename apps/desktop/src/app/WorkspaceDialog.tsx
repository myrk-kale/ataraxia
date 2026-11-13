import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import {
  workspaceCreateWorkspace,
  workspaceDeleteWorkspace,
  workspaceRegisterRepository,
  workspaceUpdateWorkspace,
  type Repository,
  type RepositoryId,
  type Workspace,
  type WorkspaceSnapshot,
} from "../lib/workspace";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Overlay";

function problemText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Makes or edits a workspace: a name and the repositories that belong to it. Its chats keep
 * seeing every member; the app still looks at one repository at a time.
 */
export function WorkspaceDialog({
  isOpen,
  workspace,
  repositories,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  /** The workspace being edited, or `null` to make a new one. */
  workspace: Workspace | null;
  /** Every repository the app knows, members or not. */
  repositories: readonly Repository[];
  onClose: () => void;
  onSaved: (snapshot: WorkspaceSnapshot) => void;
}) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<RepositoryId[]>([]);
  const [added, setAdded] = useState<Repository[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName(workspace?.name ?? "");
      setMembers(workspace?.repository_ids ?? []);
      setAdded([]);
      setProblem(null);
      setBusy(false);
    }
  }, [isOpen, workspace]);

  const known = useMemo(
    () => [...repositories, ...added.filter((item) => !repositories.some((repository) => repository.id === item.id))],
    [repositories, added],
  );

  function toggle(id: RepositoryId, on: boolean) {
    setMembers((current) => (on ? (current.includes(id) ? current : [...current, id]) : current.filter((item) => item !== id)));
  }

  async function addFolder() {
    const selected = await open({ directory: true, multiple: false, title: "Add a git repository" });
    if (typeof selected !== "string" || selected.length === 0) {
      return;
    }
    setProblem(null);
    try {
      const repository = await workspaceRegisterRepository(selected);
      setAdded((current) => [...current, repository]);
      toggle(repository.id, true);
    } catch (err) {
      setProblem(problemText(err));
    }
  }

  async function run(action: () => Promise<WorkspaceSnapshot>) {
    if (busy) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      onSaved(await action());
      onClose();
    } catch (err) {
      setProblem(problemText(err));
    } finally {
      setBusy(false);
    }
  }

  const editing = workspace !== null;
  const title = editing ? "Edit workspace" : "New workspace";

  return (
    <Dialog isOpen={isOpen} label={title} size="md" onClose={onClose}>
      <form
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() =>
            workspace ? workspaceUpdateWorkspace(workspace.id, name, members) : workspaceCreateWorkspace(name, members),
          );
        }}
      >
        <h2 className="text-heading font-semibold text-cg-ink">{title}</h2>
        <p className="text-ui leading-6 text-cg-muted-strong">
          The agent of every chat in a workspace can read and change all of its repositories. You still look at one
          repository at a time.
        </p>
        <label className="flex flex-col gap-1.5 text-ui text-cg-ink">
          <span>Name</span>
          <input
            autoComplete="off"
            autoFocus
            className="w-full rounded-cg-md border border-cg-control bg-cg-panel px-3 py-1.5 text-ui text-cg-ink focus:border-cg-ink"
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-ui text-cg-ink">Repositories</legend>
          {known.length === 0 ? (
            <p className="text-small text-cg-muted-strong">No repository is known yet. Add a folder.</p>
          ) : (
            <ul className="flex max-h-56 flex-col overflow-auto rounded-cg-md border border-cg-line">
              {known.map((repository) => (
                <li key={repository.id} className="border-b border-cg-line last:border-b-0">
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-cg-tint">
                    <input
                      checked={members.includes(repository.id)}
                      className="mt-1 h-4 w-4 flex-none"
                      type="checkbox"
                      onChange={(event) => toggle(repository.id, event.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-ui text-cg-ink">{repository.name}</span>
                      <span className="block truncate font-mono text-small text-cg-muted-strong">{repository.root}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button variant="quiet" onClick={() => void addFolder()}>
              Add folder…
            </Button>
          </div>
        </fieldset>
        {problem ? (
          <p className="text-small text-cg-red" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <div>
            {workspace ? (
              <Button
                disabled={busy}
                variant="quiet"
                onClick={() => void run(() => workspaceDeleteWorkspace(workspace.id))}
              >
                Delete workspace
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={busy || name.trim() === "" || members.length === 0} type="submit" variant="primary">
              {busy ? "Saving…" : editing ? "Save" : "Create workspace"}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
