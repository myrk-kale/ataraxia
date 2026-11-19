import { useId, useRef, useState } from "react";
import type { ContextUsage } from "../lib/agent";
import { UsageRing } from "./UsageRing";

export function ContextMeter({ usage }: { usage: ContextUsage | null }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState({ left: 0, top: 0 });
  const percent = usage && usage.size > 0 ? Math.min(100, Math.round(usage.used / usage.size * 100)) : null;
  function show() {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    setBox({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 316)), top: rect.bottom + 6 });
    panel.current?.showPopover();
  }
  return <>
    <button ref={button} type="button" aria-controls={id} aria-expanded={open} aria-haspopup="dialog" aria-label={percent === null ? "Conversation context unavailable. Show details" : `Conversation context: ${percent}% used. Show details`} title="Conversation context" className="grid h-8 w-8 flex-none cursor-pointer place-items-center rounded-cg-sm text-cg-muted-strong hover:bg-cg-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-cg-ink" onClick={show}>
      <UsageRing percent={percent} />
    </button>
    <div ref={panel} id={id} role="dialog" aria-label="Conversation context" popover="auto" className="fixed inset-auto m-0 w-[300px] rounded-cg-lg border border-cg-line bg-cg-panel p-3.5 text-cg-ink shadow-cg-pop" style={{ left: box.left, top: box.top, bottom: "auto", right: "auto" }} onToggle={(event) => setOpen((event.nativeEvent as ToggleEvent).newState === "open")} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); panel.current?.hidePopover(); button.current?.focus(); } }}>
      <h2 className="text-ui font-semibold">Conversation context</h2>
      {usage && percent !== null ? <div className="mt-3 grid gap-2 text-small"><p>{percent}% used</p><p className="text-cg-muted-strong">{usage.used.toLocaleString()} / {usage.size.toLocaleString()} tokens</p><p className="text-cg-muted">Last reported by the agent. Includes conversation and other context sent to the model.</p></div> : <p className="mt-3 text-small text-cg-muted-strong">The agent has not reported context usage for this conversation.</p>}
    </div>
  </>;
}
