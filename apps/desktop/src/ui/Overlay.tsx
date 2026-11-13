import { Drawer as HeroDrawer, Kbd, Modal, Switch as HeroSwitch, Tabs } from "@heroui/react";
import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

/** A centered or top-anchored dialog (HeroUI Modal). Esc and an outside click close it. */
export function Dialog({
  isOpen,
  onClose,
  label,
  placement = "center",
  size = "md",
  wide = false,
  className = "",
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  label: string;
  placement?: "center" | "top";
  size?: "sm" | "md" | "lg" | "full";
  /** A wide bar, as in a command palette. */
  wide?: boolean;
  /** Extra classes for the dialog itself, for a panel that needs its own width. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <Modal.Backdrop
      isDismissable
      isOpen={isOpen}
      variant="transparent"
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <Modal.Container placement={placement} size={size}>
        <Modal.Dialog
          aria-label={label}
          className={`rounded-cg-lg border border-cg-line bg-cg-panel text-cg-ink shadow-cg-float ${
            wide ? "mx-auto mt-[14vh] w-[min(760px,92vw)] max-w-none gap-0 p-0" : ""
          } ${className}`}
        >
          {children}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** A panel that slides in from the right (HeroUI Drawer). */
export function SideDrawer({
  isOpen,
  onClose,
  label,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <HeroDrawer.Backdrop
      isDismissable
      isOpen={isOpen}
      variant="transparent"
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <HeroDrawer.Content placement="right">
        <HeroDrawer.Dialog
          aria-label={label}
          className="w-[30rem] max-w-[92vw] border-l border-cg-line bg-cg-panel text-cg-ink shadow-cg-float"
        >
          {children}
        </HeroDrawer.Dialog>
      </HeroDrawer.Content>
    </HeroDrawer.Backdrop>
  );
}

const TIP_DELAY_MS = 350;
const TIP_GAP = 6;
const TIP_MARGIN = 8;

/**
 * A tooltip on one button. The button stays the only control: the wrapper is a plain span, and
 * the label is linked to the button with `aria-describedby`. It opens after a short hover or on
 * keyboard focus, Esc dismisses it, and it lives in the top layer so no scroll area clips it.
 */
export function Tip({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ "aria-describedby"?: string }>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);

  function show(delay: number) {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  }

  function hide() {
    window.clearTimeout(timer.current);
    setOpen(false);
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    const box = tip.current;
    const anchor = wrapper.current?.getBoundingClientRect();
    if (!open || !box || !anchor || typeof box.showPopover !== "function") {
      return;
    }
    box.showPopover();
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const left = Math.min(Math.max(TIP_MARGIN, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - TIP_MARGIN);
    const below = anchor.bottom + TIP_GAP;
    box.style.left = `${left}px`;
    box.style.top = `${below + height > window.innerHeight - TIP_MARGIN ? anchor.top - height - TIP_GAP : below}px`;
    return () => {
      try {
        box.hidePopover();
      } catch {
        // Already hidden.
      }
    };
  }, [open]);

  return (
    <span
      ref={wrapper}
      className="inline-flex"
      onBlur={hide}
      onFocus={(event) => {
        let visible = false;
        try {
          visible = event.target.matches(":focus-visible");
        } catch {
          // No :focus-visible support: treat focus as keyboard focus.
          visible = true;
        }
        if (visible) {
          show(0);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          // The first Esc dismisses the tooltip; it must not also close the dialog behind it.
          event.stopPropagation();
          hide();
        }
      }}
      onPointerDown={hide}
      onPointerEnter={() => show(TIP_DELAY_MS)}
      onPointerLeave={hide}
    >
      {cloneElement(children, { "aria-describedby": id })}
      <span
        ref={tip}
        className="m-0 w-max max-w-[280px] rounded-cg-sm border-0 bg-cg-tip-bg px-2.5 py-1.5 text-small leading-4 text-cg-tip-fg shadow-cg-pop"
        id={id}
        popover="manual"
        role="tooltip"
      >
        {label}
      </span>
    </span>
  );
}

/** A key cap. */
export function Key({ children }: { children: ReactNode }) {
  return <Kbd className="text-small">{children}</Kbd>;
}

export function Toggle({
  label,
  isSelected,
  isDisabled = false,
  hideLabel = false,
  onChange,
}: {
  label: string;
  isSelected: boolean;
  isDisabled?: boolean;
  /** The name stays for assistive technology; the row around the switch already says what it is. */
  hideLabel?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <HeroSwitch isDisabled={isDisabled} isSelected={isSelected} onChange={onChange}>
      <HeroSwitch.Control>
        <HeroSwitch.Thumb />
      </HeroSwitch.Control>
      <HeroSwitch.Content className={hideLabel ? "sr-only" : "text-ui text-cg-ink"}>{label}</HeroSwitch.Content>
    </HeroSwitch>
  );
}

/** A compact segmented control (HeroUI Tabs without panels). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <Tabs selectedKey={value} onSelectionChange={(key) => onChange(String(key) as T)}>
      <Tabs.ListContainer>
        <Tabs.List aria-label={label} className="text-small">
          {options.map((option) => (
            <Tabs.Tab key={option.id} id={option.id}>
              {option.label}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}
