import type { ProviderUsage, UsageWindow, UsageWindowKind } from "../lib/usage";

/** How worried to be about a window. The text always says it too; colour never has to. */
export type UsageLevel = "ok" | "warn" | "high" | "full";

export type WindowView = {
  kind: UsageWindowKind;
  /** Short label for the compact meter. */
  short: string;
  /** Name for the details and for screen readers. */
  name: string;
  /** What is shown: a window that has already reset counts as unused. */
  percent: number;
  level: UsageLevel;
  /** The window ended since the provider last reported it. */
  reset: boolean;
  /** Seconds until it starts over, when that is known and still ahead. */
  secondsLeft: number | null;
};

const SHORT: Record<UsageWindowKind, string> = { five_hour: "5h", weekly: "Week" };
const NAME: Record<UsageWindowKind, string> = {
  five_hour: "5-hour limit",
  weekly: "Weekly limit",
};

export function levelOf(percent: number): UsageLevel {
  if (percent >= 100) {
    return "full";
  }
  if (percent >= 90) {
    return "high";
  }
  return percent >= 75 ? "warn" : "ok";
}

/**
 * One window as of `now` (Unix seconds). A provider only speaks while it works, so a window
 * whose end has passed since it spoke has started over and nothing has been spent in it.
 */
export function viewWindow(window: UsageWindow, now: number): WindowView {
  const over = window.resetsAt !== null && window.resetsAt <= now;
  const percent = over ? 0 : Math.max(0, Math.min(100, Math.round(window.usedPercent)));
  return {
    kind: window.kind,
    short: SHORT[window.kind],
    name: NAME[window.kind],
    percent,
    level: levelOf(percent),
    reset: over,
    secondsLeft: window.resetsAt !== null && !over ? window.resetsAt - now : null,
  };
}

/** The windows of a provider as of `now`, the short one first. */
export function viewUsage(usage: ProviderUsage, now: number): WindowView[] {
  return usage.windows
    .filter((window, at, all) => all.findIndex((item) => item.kind === window.kind) === at)
    .map((window) => viewWindow(window, now))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "five_hour" ? -1 : 1));
}

/** "in 42 min", "in 3 h 12 min", "in 2 d 4 h". */
export function formatReset(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) {
    return `in ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  const spare = hours % 24;
  return spare === 0 ? `in ${days} d` : `in ${days} d ${spare} h`;
}

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
export function formatAge(updatedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/** The same fact as the meter, in words: for the button's name. */
export function describeWindow(view: WindowView): string {
  if (view.reset) {
    return `${view.name}: reset, nothing used yet`;
  }
  const when = view.secondsLeft === null ? "" : `, resets ${formatReset(view.secondsLeft)}`;
  return `${view.name}: ${view.percent}% used${when}`;
}

/** "Pro", "Plus"... as the provider spelled it. */
export function planLabel(plan: string): string {
  return plan
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
