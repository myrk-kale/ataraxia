import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";

/** A borderless native select that reads as plain text with a small chevron. */
export function QuietSelect({
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative inline-flex min-w-0 items-center">
      <select
        className={`min-w-0 field-sizing-content cursor-pointer appearance-none truncate rounded-[5px] border-0 bg-transparent py-1.5 pr-4 outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-0 text-cg-muted"
        size={12}
      />
    </span>
  );
}
