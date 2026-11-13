import { RefreshCw } from "lucide-react";
import { Button } from "../ui/Button";
import { Tip } from "../ui/Overlay";

/**
 * What the Code navigator is showing (`feat/x against develop`) and the button that reads it
 * again. A long branch or reference name is cut with an ellipsis, never allowed to push the
 * button out or spill past the panel: the whole text stays in the DOM for assistive technology
 * and in the tooltip for everyone else.
 */
export function ShownRow({
  text,
  hint,
  refreshHint,
  onRefresh,
}: {
  text: string;
  hint: string;
  refreshHint: string;
  onRefresh: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <p
        className="min-w-0 flex-1 truncate px-1.5 py-1 text-small text-cg-muted-strong"
        data-testid="shown-label"
        title={`${text}. ${hint}`}
      >
        <span className="sr-only">Showing: </span>
        {text}
      </p>
      <Tip className="inline-flex flex-none" label={refreshHint}>
        <Button aria-label="Refresh checkpoint" className="flex-none" variant="icon" onClick={onRefresh}>
          <RefreshCw aria-hidden="true" size={14} />
        </Button>
      </Tip>
    </div>
  );
}
