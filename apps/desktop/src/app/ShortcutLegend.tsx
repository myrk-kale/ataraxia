import { Dialog, Key } from "../ui/Overlay";
import { SHORTCUT_LEGEND } from "./shortcuts";

export function ShortcutLegend({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  return (
    <Dialog isOpen={isOpen} label="Keyboard shortcuts" size="md" onClose={onClose}>
      <div className="flex flex-col gap-4 p-6">
        <h2 className="text-heading font-semibold text-cg-ink">Keyboard shortcuts</h2>
        <ul className="flex flex-col">
          {SHORTCUT_LEGEND.map((row) => (
            <li key={row.label} className="flex items-center gap-3 border-b border-cg-line py-2 last:border-b-0">
              <span className="flex w-[130px] flex-none items-center gap-1">
                {row.keys.map((key) => (
                  <Key key={key}>{key}</Key>
                ))}
              </span>
              <span className="min-w-0 flex-1 text-small text-cg-ink">{row.label}</span>
              <span className="flex-none text-small text-cg-muted">{row.scope}</span>
            </li>
          ))}
        </ul>
        <p className="text-small text-cg-muted">Shortcuts never fire while you type, compose with an IME or edit code.</p>
      </div>
    </Dialog>
  );
}
