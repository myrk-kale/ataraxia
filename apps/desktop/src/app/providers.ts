import type { ProviderDescriptor } from "../lib/agent";
import type { ProviderKind } from "../lib/workspace";

/**
 * The providers a person can choose from. The demo provider answers with scripted text, so it
 * is for development and tests: a release build hides it, unless an older chat still runs on it.
 */
export function visibleProviders(
  providers: readonly ProviderDescriptor[],
  inUse: ProviderKind | null,
  development: boolean,
): ProviderDescriptor[] {
  return providers.filter((item) => item.kind !== "fake" || development || inUse === "fake");
}

/** The provider for the next chat: the remembered one if it can run, else the first that can. */
export function pickProvider(
  choices: readonly ProviderDescriptor[],
  preferred: ProviderKind | null,
): ProviderKind | null {
  return (
    choices.find((item) => item.kind === preferred && item.available)?.kind ??
    choices.find((item) => item.available)?.kind ??
    null
  );
}
