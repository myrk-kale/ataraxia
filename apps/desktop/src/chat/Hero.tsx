import type { ReactNode } from "react";

/** The centered "What shall we build?" block shared by the empty chat and the no-session state. */
export function Hero({
  contextLabel,
  children,
}: {
  contextLabel: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto my-auto max-w-[650px] px-[30px] text-center">
      <h1 className="mb-[9px] text-display font-semibold tracking-[-0.6px]">
        What shall we build?
      </h1>
      {contextLabel ? (
        <p className="text-small text-cg-muted">{contextLabel.replace(" · ", "  ·  ")}</p>
      ) : null}
      {children}
    </div>
  );
}
