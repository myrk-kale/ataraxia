import { Bot, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useAgentActivity } from "../lib/browser";
import { Button } from "../ui/Button";

/**
 * Says that an agent is using the browser when the developer is somewhere else, with a way to go
 * and watch. It goes when the agent stops, so it is never a thing to dismiss, but it can be.
 */
export function BrowserNotice({ inBrowser, onWatch }: { inBrowser: boolean; onWatch: () => void }) {
  const activity = useAgentActivity();
  const [dismissed, setDismissed] = useState(false);
  const busy = activity?.busy === true;
  // A new burst of work is worth saying again, after it was waved off.
  useEffect(() => {
    if (!busy) setDismissed(false);
  }, [busy]);
  if (!busy || inBrowser || dismissed) {
    return null;
  }
  return (
    <div
      className="absolute bottom-5.5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-cg-md border border-cg-accent/40 bg-cg-float px-3.5 py-2.5 text-small text-cg-ink shadow-cg-pop"
      role="status"
    >
      <Bot aria-hidden="true" className="text-cg-accent" size={15} />
      <span>An agent is using the browser</span>
      <Button size="sm" variant="quiet" onClick={onWatch}>
        Watch
      </Button>
      <button aria-label="Dismiss" className="grid h-6 w-6 place-items-center rounded-cg-sm text-cg-muted hover:bg-cg-tint" type="button" onClick={() => setDismissed(true)}>
        <X aria-hidden="true" size={13} />
      </button>
    </div>
  );
}
