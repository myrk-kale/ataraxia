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
      className="cg-page-in absolute right-[22px] bottom-[22px] z-50 flex max-w-[420px] items-start gap-3 rounded-[9px] bg-cg-tip-bg px-[15px] py-[11px] text-small text-cg-tip-fg shadow-lg"
      role="alert"
    >
      <span className="min-w-0 break-words">{message}</span>
      <button
        aria-label="Dismiss"
        className="-mt-0.5 flex-none text-[16px] leading-none opacity-70 hover:opacity-100"
        type="button"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
