import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "quiet" | "danger" | "icon";
type Size = "md" | "sm";

const BASE =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors active:translate-y-px disabled:opacity-40 disabled:active:translate-y-0";

/** Colour and border per role. Padding comes from the size, so no call needs to override it. */
const VARIANTS: Record<Variant, string> = {
  primary:
    "rounded-cg-md border border-cg-primary bg-cg-primary font-semibold text-cg-on-primary hover:bg-cg-primary-hover active:bg-cg-primary-hover",
  secondary:
    "rounded-cg-md border border-cg-line-strong bg-cg-panel font-medium text-cg-ink hover:bg-cg-tint active:bg-cg-line aria-pressed:bg-cg-tint",
  quiet:
    "rounded-cg-md border border-cg-line bg-cg-panel text-cg-muted-strong hover:border-cg-line-strong hover:text-cg-ink active:bg-cg-line aria-pressed:border-cg-line-strong aria-pressed:bg-cg-tint aria-pressed:text-cg-ink",
  danger:
    "rounded-cg-md border border-cg-red bg-cg-red font-semibold text-cg-on-primary hover:opacity-90 active:opacity-80",
  icon: "h-7 w-7 rounded-cg-sm text-cg-muted-strong hover:bg-cg-tint hover:text-cg-ink active:bg-cg-line aria-pressed:bg-cg-tint aria-pressed:text-cg-ink",
};

const SIZES: Record<Size, string> = {
  md: "px-3.5 py-2.5 text-ui",
  sm: "px-2.5 py-1 text-small",
};

export function Button({
  variant = "secondary",
  size,
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  // A quiet button is a secondary action next to content, so it defaults to the compact size.
  const resolved: Size = size ?? (variant === "quiet" ? "sm" : "md");
  const padding = variant === "icon" ? "" : SIZES[resolved];
  return (
    <button
      className={`${BASE} ${VARIANTS[variant]} ${padding} ${className}`}
      type={type}
      {...props}
    />
  );
}
