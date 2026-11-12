import type { ModelChoice, ProviderDescriptor, SessionOptions } from "../lib/agent";

/** Models on offer: what the live session reports, else the provider's built-in presets. */
export function modelChoices(
  provider: ProviderDescriptor | null,
  options: SessionOptions | null,
): ModelChoice[] {
  if (options && options.models.length > 0) {
    return options.models;
  }
  return provider?.settings.models ?? [];
}

function chosenModel(
  provider: ProviderDescriptor | null,
  options: SessionOptions | null,
  model: string | null,
): ModelChoice | undefined {
  const wanted = model ?? options?.default_model ?? null;
  return modelChoices(provider, options).find((item) => item.id === wanted);
}

/** Effort levels for a model: its own list, else the session's, else the provider's fixed list. */
export function effortsFor(
  provider: ProviderDescriptor | null,
  options: SessionOptions | null,
  model: string | null,
): string[] {
  const chosen = chosenModel(provider, options, model);
  if (chosen && chosen.efforts.length > 0) {
    return chosen.efforts;
  }
  if (options && options.efforts.length > 0) {
    return options.efforts;
  }
  return provider?.settings.efforts ?? [];
}

/** The effort to keep after the model changes; levels that no longer apply are dropped. */
export function effortAfterModelChange(
  provider: ProviderDescriptor | null,
  options: SessionOptions | null,
  model: string | null,
  effort: string | null,
): string | null {
  if (!effort) {
    return null;
  }
  const chosen = chosenModel(provider, options, model);
  if (chosen && chosen.efforts.length > 0) {
    return chosen.efforts.includes(effort) ? effort : null;
  }
  // Levels unknown: providers whose levels depend on the model start over, fixed ones keep it.
  return provider?.settings.dynamic ? null : effort;
}
