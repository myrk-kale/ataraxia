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
    <div className="mx-auto mt-[16vh] max-w-[650px] px-[30px] text-center">
      <div aria-hidden="true" className="mb-3.5 text-[29px] leading-none text-cg-accent">
        ✳
      </div>
      <h1 className="mb-[9px] text-[25px] font-semibold tracking-[-0.8px]">
        What shall we build?
      </h1>
      {contextLabel ? (
        <p className="text-small text-cg-muted">{contextLabel.replace(" · ", "  ·  ")}</p>
      ) : null}
      {children}
    </div>
  );
}
