import { TriangleAlert } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useActiveProfile, type HarnessProfile } from "../lib/profiles";
import type { ProviderUsage } from "../lib/usage";
import type { ProviderKind } from "../lib/workspace";
import { useNowSeconds, useProviderUsage } from "./useProviderUsage";
import {
  describeWindow,
  formatAge,
  formatReset,
  planLabel,
  viewUsage,
  type UsageLevel,
  type WindowView,
} from "./usageView";

const FILL: Record<UsageLevel, string> = {
  ok: "bg-cg-muted-strong",
  warn: "bg-cg-amber",
  high: "bg-cg-red",
  full: "bg-cg-red",
};

const TEXT: Record<UsageLevel, string> = {
  ok: "text-cg-muted-strong",
  warn: "font-semibold text-cg-amber-text",
  high: "font-semibold text-cg-del-fg",
  full: "font-semibold text-cg-del-fg",
};

/** A share as a bar. The number beside it says the same thing, so the colour is only a hint. */
function Bar({ view, className }: { view: WindowView; className: string }) {
  const filled = view.percent > 0 ? Math.max(view.percent, 3) : 0;
  return (
    <span
      aria-hidden="true"
      className={`block h-1 flex-none overflow-hidden rounded-full bg-cg-line-strong ${className}`}
    >
      <span
        className={`block h-full rounded-full ${FILL[view.level]}`}
        style={{ width: `${filled}%` }}
      />
    </span>
  );
}

function Share({ view }: { view: WindowView }) {
  return (
    <span className={`flex items-center gap-1 tabular-nums ${TEXT[view.level]}`}>
      {view.level === "ok" ? null : <TriangleAlert aria-hidden="true" size={11} />}
      {view.percent}%
    </span>
  );
}

/** "Sat 14:30" for the weekly window, "14:30" for the short one, in the person's own clock. */
function clock(seconds: number, weekly: boolean): string {
  return new Date(seconds * 1000).toLocaleString("en-GB", {
    weekday: weekly ? "short" : undefined,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function WindowDetails({ view, resetsAt }: { view: WindowView; resetsAt: number | null }) {
  let note: string;
  if (view.reset) {
    note = "It has reset. It starts again with your next message.";
  } else if (view.secondsLeft === null || resetsAt === null) {
    note = "The reset time was not reported.";
  } else {
    note = `Resets ${formatReset(view.secondsLeft)} (${clock(resetsAt, view.kind === "weekly")})`;
  }
  return (
    <section className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-small">
        <h3 className="font-semibold text-cg-ink">{view.name}</h3>
        <span className={`flex items-center gap-1 tabular-nums ${TEXT[view.level]}`}>
          {view.level === "ok" ? null : <TriangleAlert aria-hidden="true" size={11} />}
          {view.level === "full" ? "Limit reached" : `${view.percent}% used`}
        </span>
      </div>
      <Bar className="w-full" view={view} />
      <p className="text-small text-cg-muted">{note}</p>
    </section>
  );
}

/**
 * The view of a provider's limits, given what it last reported and the time. Split from
 * `UsageMeter` so it can be drawn without the app around it.
 */
export function UsageView({
  usage,
  label,
  now,
  profile = null,
}: {
  usage: ProviderUsage;
  label: string;
  now: number;
  /** The profile (account) these limits are of, when one is in use. */
  profile?: Pick<HarnessProfile, "name" | "color"> | null;
}) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState({ left: 0, bottom: 0 });
  const views = viewUsage(usage, now);
  if (views.length === 0) {
    return null;
  }

  function show() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    // The meter lives in the composer at the bottom of the window: the details open upwards,
    // and never past the right edge.
    setBox({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 316)),
      bottom: window.innerHeight - rect.top + 6,
    });
    menuRef.current?.showPopover();
  }

  const spoken = views.map(describeWindow).join(". ");
  return (
    <>
      <button
        ref={triggerRef}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label}${profile ? ` (${profile.name})` : ""} limits. ${spoken}. Show details`}
        className="flex flex-none cursor-pointer items-center gap-3 rounded-cg-sm px-1.5 py-1 text-small outline-none hover:bg-cg-line"
        type="button"
        onClick={show}
      >
        {views.map((view) => (
          <span key={view.kind} className="flex items-center gap-1.5">
            <span className="text-cg-muted-strong">{view.short}</span>
            <Bar className="w-8" view={view} />
            <Share view={view} />
          </span>
        ))}
      </button>
      <div
        ref={menuRef}
        aria-label={`${label} usage limits`}
        className="fixed inset-auto m-0 w-[300px] rounded-cg-lg border border-cg-line bg-cg-panel p-3.5 text-cg-ink shadow-cg-pop"
        id={menuId}
        popover="auto"
        role="dialog"
        style={{ left: box.left, bottom: box.bottom, top: "auto", right: "auto" }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // Closes this and nothing behind it.
            event.stopPropagation();
            menuRef.current?.hidePopover();
            triggerRef.current?.focus();
          }
        }}
        onToggle={(event) => setOpen((event.nativeEvent as ToggleEvent).newState === "open")}
      >
        {/* The popover element itself keeps the browser's `display`, or it would never hide. */}
        <div className="grid gap-3.5">
          <header className="grid gap-1">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-ui font-semibold">{label} limits</h2>
              {usage.plan ? (
                <span className="rounded-cg-sm border border-cg-line-strong px-1.5 py-0.5 text-small text-cg-muted-strong">
                  {planLabel(usage.plan)}
                </span>
              ) : null}
            </div>
            {profile ? (
              <p className="flex items-center gap-1.5 text-small text-cg-muted-strong">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 flex-none rounded-full"
                  style={{ background: profile.color }}
                />
                Profile: {profile.name}
              </p>
            ) : null}
          </header>
          {views.map((view) => (
            <WindowDetails
              key={view.kind}
              resetsAt={usage.windows.find((item) => item.kind === view.kind)?.resetsAt ?? null}
              view={view}
            />
          ))}
          <p className="border-t border-cg-line pt-2.5 text-small text-cg-muted">
            Reported {formatAge(usage.updatedAt, now)} by {label}. It updates while the agent works.
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * The five-hour and weekly limits of the provider the chat runs on, small, next to its name.
 * Providers that report no limits (or have not yet) show nothing.
 */
export function UsageMeter({ provider, label }: { provider: ProviderKind; label: string }) {
  const profile = useActiveProfile(provider);
  const usage = useProviderUsage(provider, profile?.id ?? null);
  const tick = useNowSeconds();
  if (!usage || usage.windows.length === 0) {
    return null;
  }
  // The clock only moves every so often; a report that has just come in is never "ahead" of it.
  return <UsageView label={label} now={Math.max(tick, usage.updatedAt)} profile={profile} usage={usage} />;
}
