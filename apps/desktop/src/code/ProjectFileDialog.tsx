import { useId, useState, type FormEvent } from "react";
import type { ProjectFileAction } from "../lib/insights";
import { errorText } from "../lib/useInsightEvents";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Overlay";

export type FileRequest = {
  kind: "create-file" | "create-folder" | "rename" | "move" | "trash";
  path: string;
};

const LABELS: Record<FileRequest["kind"], string> = {
  "create-file": "New file",
  "create-folder": "New folder",
  rename: "Rename",
  move: "Move",
  trash: "Move to Trash",
};

export function ProjectFileDialog({
  request,
  onSubmit,
  onClose,
}: {
  request: FileRequest;
  onSubmit: (action: ProjectFileAction) => Promise<void>;
  onClose: () => void;
}) {
  const { kind, path } = request;
  const slash = path.lastIndexOf("/");
  const original = kind === "rename" ? path.slice(slash + 1) : kind === "move" ? path : "";
  const [name, setName] = useState(original);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fieldId = useId();
  const problemId = useId();
  const label = LABELS[kind];
  const creating = kind === "create-file" || kind === "create-folder";
  const trashing = kind === "trash";
  const destinationFolder = creating ? path : path.slice(0, Math.max(slash, 0));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    if (kind !== "move" && !trashing && name.includes("/")) {
      setProblem("Enter a name without a slash.");
      return;
    }
    const destination = destinationFolder ? `${destinationFolder}/${name}` : name;
    const action: ProjectFileAction = trashing
      ? { kind, path }
      : creating
        ? { kind, path: destination }
        : { kind: "move", path, to: kind === "move" ? name : destination };
    setBusy(true);
    setProblem(null);
    try {
      await onSubmit(action);
      onClose();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (!busy) {
      onClose();
    }
  }

  return (
    <Dialog isOpen label={label} size="sm" onClose={close}>
      <form className="flex flex-col gap-4 p-6" onSubmit={(event) => void submit(event)}>
        <h2 className="text-heading font-semibold">{trashing ? "Move this item to Trash?" : label}</h2>
        <p className="break-all font-mono text-small text-cg-muted-strong">{path || "Project root"}</p>
        {!trashing ? (
          <label className="flex flex-col gap-1.5 text-ui" htmlFor={fieldId}>
            {kind === "move" ? "Destination path from project root" : "Name"}
            <input
              aria-describedby={problem ? problemId : undefined}
              autoFocus
              className="w-full rounded-cg-md border border-cg-control bg-cg-panel px-3 py-1.5 text-ui"
              id={fieldId}
              readOnly={busy}
              required
              spellCheck={false}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onFocus={(event) => {
                if (kind === "rename") {
                  event.target.select();
                }
              }}
            />
          </label>
        ) : null}
        {problem ? <p className="break-words text-small text-cg-red" id={problemId} role="alert">{problem}</p> : null}
        <div className="flex justify-end gap-2">
          <Button autoFocus={trashing} disabled={busy} variant="quiet" onClick={close}>Cancel</Button>
          <Button
            disabled={busy || (!trashing && (!name.trim() || name === original))}
            type="submit"
            variant={trashing ? "danger" : "primary"}
          >
            {busy ? "Working…" : label}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
