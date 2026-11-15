import { AtSign, File, Folder, Slash, Users } from "lucide-react";
import { useEffect, useRef } from "react";
import type { PickerItem } from "./pickerChoices";

const ICONS = {
  command: Slash,
  file: File,
  dir: Folder,
  agent: Users,
} as const;

/** The id of one row, which the message field names as its active descendant. */
export function pickerOptionId(listId: string, item: PickerItem): string {
  return `${listId}-${item.id}`;
}

/**
 * The list that opens above the message field while a `/command` or an `@mention` is typed. The
 * field keeps the focus: the arrows, Enter, Tab and Esc are handled there, and this only shows
 * the choices and takes a click.
 */
export function ComposerPicker({
  id,
  label,
  items,
  active,
  onPick,
  onHover,
}: {
  id: string;
  label: string;
  items: PickerItem[];
  active: number;
  onPick: (item: PickerItem) => void;
  onHover: (index: number) => void;
}) {
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, items]);

  if (items.length === 0) {
    return null;
  }
  return (
    <ul
      aria-label={label}
      className="absolute right-0 bottom-full left-0 z-20 mb-2 max-h-[min(280px,45vh)] overflow-auto rounded-cg-lg border border-cg-line bg-cg-panel p-1.5 text-cg-ink shadow-cg-pop"
      id={id}
      role="listbox"
    >
      {items.map((item, index) => {
        const Icon = ICONS[item.kind] ?? AtSign;
        const selected = index === active;
        return (
          <li
            key={item.id}
            ref={selected ? activeRef : undefined}
            aria-selected={selected}
            className={`flex cursor-pointer items-center gap-2.5 rounded-cg-md px-2.5 py-1.5 text-small ${
              selected ? "bg-cg-tint" : ""
            }`}
            id={pickerOptionId(id, item)}
            role="option"
            // The field must not lose its caret to a click on a row.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(item)}
            onMouseMove={() => {
              if (!selected) {
                onHover(index);
              }
            }}
          >
            <Icon aria-hidden="true" className="flex-none text-cg-muted" size={13} />
            <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
              <span className="flex-none font-medium">{item.label}</span>
              {item.detail ? (
                <span className="truncate text-cg-muted-strong">{item.detail}</span>
              ) : null}
            </span>
            {item.aside ? (
              <span className="max-w-[40%] flex-none truncate text-cg-muted">{item.aside}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
