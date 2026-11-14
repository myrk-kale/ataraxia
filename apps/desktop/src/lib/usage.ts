import { invoke } from "@tauri-apps/api/core";
import type { ProviderKind } from "./workspace";

export type UsageWindowKind = "five_hour" | "weekly";

export type UsageWindow = {
  kind: UsageWindowKind;
  /** 0 to 100. */
  usedPercent: number;
  /** When the window starts over, in Unix seconds. */
  resetsAt: number | null;
};

/** Where a provider's subscription limits stand, as the provider last reported them. */
export type ProviderUsage = {
  provider: ProviderKind;
  /** The profile (account) the limits are of; `null` for the default way of starting. */
  profile: string | null;
  plan: string | null;
  windows: UsageWindow[];
  /** When it was reported, in Unix seconds. */
  updatedAt: number;
};

export function agentUsage() {
  return invoke<ProviderUsage[]>("agent_usage");
}
