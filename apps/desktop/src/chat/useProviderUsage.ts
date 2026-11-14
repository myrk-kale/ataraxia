import { useEffect, useState } from "react";
import { listenAgentEvents } from "../lib/agent";
import { agentUsage, type ProviderUsage } from "../lib/usage";
import type { ProviderKind } from "../lib/workspace";

/**
 * The limits of one provider: what was last known when the chat opened, then every report as it
 * comes. `null` while nothing is known, and for providers that report no limits.
 */
export function useProviderUsage(provider: ProviderKind, profile: string | null): ProviderUsage | null {
  const [usage, setUsage] = useState<ProviderUsage | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    setUsage(null);
    void (async () => {
      unlisten = await listenAgentEvents((event) => {
        if (event.type === "usage" && event.usage.provider === provider && event.usage.profile === profile) {
          setUsage(event.usage);
        }
      });
      if (disposed) {
        unlisten();
        return;
      }
      try {
        const known = await agentUsage();
        if (!disposed) {
          // A report that came in while this was loading is newer than what was loaded.
          setUsage(
            (current) =>
              current ?? known.find((item) => item.provider === provider && item.profile === profile) ?? null,
          );
        }
      } catch {
        // The limits are a convenience; the chat works without them.
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [provider, profile]);

  return usage;
}

/** The time in Unix seconds, read again every `everyMs`, so countdowns stay true. */
export function useNowSeconds(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}
