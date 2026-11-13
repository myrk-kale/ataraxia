import { CircleAlert, X } from "lucide-react";

export function Toast({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  if (!message) {
    return null;
  }
  return (
    <div
      className="absolute right-5.5 bottom-5.5 z-50 flex max-w-[420px] items-start gap-3 rounded-cg-md border border-cg-line-strong bg-cg-float px-4 py-3 text-small leading-5 text-cg-ink shadow-cg-pop"
      role="alert"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 flex-none text-cg-red" size={15} />
      <span className="min-w-0 break-words whitespace-pre-line">{message}</span>
      <button
        aria-label="Dismiss message"
        className="-mt-0.5 -mr-1 grid h-6 w-6 flex-none place-items-center rounded-cg-sm text-cg-muted-strong hover:bg-cg-tint hover:text-cg-ink"
        type="button"
        onClick={onDismiss}
      >
        <X aria-hidden="true" size={14} />
      </button>
    </div>
  );
}
