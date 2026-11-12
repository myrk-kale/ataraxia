import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "quiet" | "icon";

const BASE =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors disabled:opacity-40";

const VARIANTS: Record<Variant, string> = {
  primary:
    "rounded-[9px] border border-cg-primary bg-cg-primary px-3.5 py-2.5 text-[12px] font-semibold text-cg-on-primary hover:bg-cg-primary-hover",
  secondary:
    "rounded-[9px] border border-cg-line-strong bg-cg-panel px-3.5 py-2.5 text-[12px] font-medium text-cg-ink hover:bg-cg-tint",
  quiet:
    "rounded-lg border border-cg-line bg-cg-panel px-3 py-2 text-small text-cg-muted-strong hover:border-cg-line-strong hover:text-cg-ink",
  icon: "h-[29px] w-[29px] rounded-[7px] text-cg-muted hover:bg-cg-tint hover:text-cg-ink aria-pressed:bg-cg-tint aria-pressed:text-cg-ink",
};

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`${BASE} ${VARIANTS[variant]} ${className}`}
      type={type}
      {...props}
    />
  );
}
