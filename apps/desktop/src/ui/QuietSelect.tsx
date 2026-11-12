import { Check, ChevronDown } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface SelectOption {
  value: string;
  label: string;
  /** Shorter text for the trigger when this option is selected. */
  display?: string;
  disabled?: boolean;
  hint?: string;
}

export interface SelectAction {
  label: string;
  onSelect: () => void;
}

interface QuietSelectProps {
  "aria-label": string;
  value: string;
  options: SelectOption[];
  /** Extra commands listed under a divider; they never become the selected value. */
  actions?: SelectAction[];
  placeholder?: string;
  /** Small glyph shown before the label on the trigger. */
  icon?: ReactNode;
  /** Extra content at the bottom of the list; `close` dismisses the popover. */
  footer?: (close: () => void) => ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  onChange: (value: string) => void;
}

const ITEM =
  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-small outline-none hover:bg-cg-tint focus-visible:bg-cg-tint disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A borderless picker that reads as plain text with a small chevron. The list is a native
 * popover (light dismiss, Esc and focus return come from the platform) styled like the other
 * app popovers, so it never falls back to the OS menu.
 */
export function QuietSelect({
  "aria-label": ariaLabel,
  value,
  options,
  actions = [],
  placeholder = "",
  icon,
  footer,
  className = "",
  disabled,
  title,
  onChange,
}: QuietSelectProps) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{
    left: number | "auto";
    right: number | "auto";
    top: number | "auto";
    bottom: number | "auto";
    minWidth: number;
  }>({ left: 0, right: "auto", top: 0, bottom: "auto", minWidth: 0 });
  const selected = options.find((option) => option.value === value);

  function items(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
  }

  function show() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || disabled) {
      return;
    }
    // Triggers in the right half open leftwards so the list never leaves the window.
    const anchorRight = rect.left > window.innerWidth / 2;
    // Near the bottom of the window (the composer) the list opens upwards.
    const below = window.innerHeight - rect.bottom;
    const openUp = below < 280 && rect.top > below;
    setBox({
      left: anchorRight ? "auto" : rect.left,
      right: anchorRight ? window.innerWidth - rect.right : "auto",
      top: openUp ? "auto" : rect.bottom + 6,
      bottom: openUp ? window.innerHeight - rect.top + 6 : "auto",
      minWidth: Math.max(rect.width, 200),
    });
    menuRef.current?.showPopover();
  }

  function close() {
    menuRef.current?.hidePopover();
  }

  function onToggle(event: React.SyntheticEvent<HTMLElement>) {
    const isOpen = (event.nativeEvent as ToggleEvent).newState === "open";
    setOpen(isOpen);
    if (isOpen) {
      const list = items();
      (list.find((item) => item.getAttribute("aria-selected") === "true") ?? list[0])?.focus();
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (index: number) => {
      event.preventDefault();
      list[(index + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") {
      move(at + 1);
    } else if (event.key === "ArrowUp") {
      move(at - 1);
    } else if (event.key === "Home") {
      move(0);
    } else if (event.key === "End") {
      move(list.length - 1);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={`inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-[5px] py-1.5 outline-none hover:text-cg-ink focus-visible:text-cg-ink disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        disabled={disabled}
        title={title}
        type="button"
        onClick={show}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            show();
          }
        }}
      >
        {icon ? (
          <span aria-hidden="true" className="flex-none text-cg-muted">
            {icon}
          </span>
        ) : null}
        <span className="truncate">{selected?.display ?? selected?.label ?? placeholder}</span>
        <ChevronDown aria-hidden="true" className="flex-none text-cg-muted" size={12} />
      </button>

      <div
        ref={menuRef}
        className="cg-page-in fixed inset-auto m-0 max-h-[min(360px,70vh)] max-w-[340px] overflow-auto rounded-xl border border-cg-line bg-cg-panel p-1.5 text-cg-ink shadow-[0_18px_50px_rgba(27,30,26,0.12)]"
        id={menuId}
        popover="auto"
        style={{
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          minWidth: box.minWidth,
        }}
        onKeyDown={onMenuKeyDown}
        onToggle={onToggle}
      >
        <div aria-label={ariaLabel} role="listbox">
          {options.map((option) => (
            <button
              key={option.value}
              aria-disabled={option.disabled}
              aria-selected={option.value === value}
              className={ITEM}
              disabled={option.disabled}
              role="option"
              title={option.hint}
              type="button"
              onClick={() => {
                close();
                if (option.value !== value) {
                  onChange(option.value);
                }
              }}
            >
              <span className="grid w-3 flex-none place-items-center text-cg-accent">
                {option.value === value ? <Check aria-hidden="true" size={12} /> : null}
              </span>
              <span className="truncate">{option.label}</span>
            </button>
          ))}
        </div>
        {footer ? <div className="mt-1 border-t border-cg-line p-1.5 pt-2">{footer(close)}</div> : null}
        {actions.length > 0 ? (
          <div className={options.length > 0 ? "mt-1 border-t border-cg-line pt-1" : ""}>
            {actions.map((action) => (
              <button
                key={action.label}
                className={`${ITEM} text-cg-muted-strong`}
                type="button"
                onClick={() => {
                  close();
                  action.onSelect();
                }}
              >
                <span className="w-3 flex-none" />
                <span className="truncate">{action.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
