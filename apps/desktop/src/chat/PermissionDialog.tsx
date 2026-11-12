import { Button } from "@heroui/react";
import { useEffect, useRef } from "react";
import type { PendingPermission } from "../lib/agent";

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
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-foreground/15 bg-background p-5 text-foreground shadow-xl backdrop:bg-black/40"
      onCancel={(event) => event.preventDefault()}
    >
      {pending ? (
        <div className="space-y-4">
          <div>
            <h2 id="permission-title" className="text-base font-medium">
              Permission needed
            </h2>
            <p className="mt-1 text-sm text-foreground/70">{pending.detail}</p>
          </div>
          <p className="rounded-md bg-foreground/5 px-3 py-2 font-mono text-xs">
            {pending.toolName}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onPress={() => onResolve(false)}>
              Deny
            </Button>
            <Button variant="primary" onPress={() => onResolve(true)}>
              Approve
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
