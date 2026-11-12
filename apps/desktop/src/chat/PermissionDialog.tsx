import { useEffect, useRef } from "react";
import type { PendingPermission } from "../lib/agent";
import { Button } from "../ui/Button";

export function PermissionDialog({
  pending,
  onResolve,
}: {
  pending: PendingPermission | null;
  onResolve: (allow: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    if (pending && !dialog.open) {
      dialog.showModal();
    }
    if (!pending && dialog.open) {
      dialog.close();
    }
  }, [pending]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="permission-title"
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-[15px] border border-cg-line-strong bg-cg-panel p-0 text-cg-ink shadow-cg-float backdrop:bg-[var(--cg-backdrop)] backdrop:backdrop-blur-[3px]"
      onCancel={(event) => event.preventDefault()}
    >
      {pending ? (
        <div className="space-y-5 px-8 py-7">
          <div>
            <span className="text-micro font-bold tracking-[1.15px] text-cg-muted-strong uppercase">
              Permission needed
            </span>
            <h2
              id="permission-title"
              className="mt-2.5 text-[17px] leading-snug font-semibold tracking-[-0.4px]"
            >
              {pending.detail}
            </h2>
          </div>
          <p className="rounded-[9px] bg-cg-tint px-3.5 py-3 font-mono text-small text-cg-muted-strong">
            {pending.toolName}
          </p>
          <div className="flex justify-end gap-2.5">
            <Button className="min-w-[100px]" onClick={() => onResolve(false)}>
              Deny
            </Button>
            <Button className="min-w-[100px]" variant="primary" onClick={() => onResolve(true)}>
              Approve
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
