import { visibleProviders } from "../app/providers";
import type { ModelChoice, ProviderDescriptor } from "../lib/agent";
import type { ChatSession, ProviderKind } from "../lib/workspace";
import type { SelectOption } from "../ui/QuietSelect";

export type ModelPick = { provider: ProviderKind; model: string | null };

const SEP = "::";
export const encodePick = (pick: ModelPick): string => `${pick.provider}${SEP}${pick.model ?? ""}`;

export function decodePick(value: string): ModelPick {
  const [provider = "", ...rest] = value.split(SEP);
  return { provider: provider as ProviderKind, model: rest.join(SEP) || null };
}

/**
 * Every model a BTW can run on: each provider's default and its models. The chat's own provider
 * lists the models it really reports; the others list their presets.
 */
export function modelChoices(
  providers: readonly ProviderDescriptor[],
  chat: Pick<ChatSession, "provider"> | null,
  live: readonly ModelChoice[],
  development: boolean,
): SelectOption[] {
  const out: SelectOption[] = [];
  for (const provider of visibleProviders(providers, chat?.provider ?? null, development)) {
    const models = chat?.provider === provider.kind && live.length > 0 ? live : provider.settings.models;
    const unavailable = !provider.available;
    out.push({
      value: encodePick({ provider: provider.kind, model: null }),
      label: `${provider.display_name} · Default`,
      disabled: unavailable,
      hint: unavailable ? (provider.detail ?? "Not installed") : undefined,
    });
    if (unavailable) {
      continue;
    }
    for (const model of models) {
      out.push({
        value: encodePick({ provider: provider.kind, model: model.id }),
        label: `${provider.display_name} · ${model.label}`,
      });
    }
  }
  return out;
}

/** What is selected to begin with: the last choice if it is still on offer, else the chat's own. */
export function startingChoice(options: readonly SelectOption[], chat: Pick<ChatSession, "provider"> | null, remembered: string | null): string {
  const usable = (value: string | null) => (value && options.some((option) => option.value === value && !option.disabled) ? value : null);
  return (
    usable(remembered) ??
    usable(chat ? encodePick({ provider: chat.provider, model: null }) : null) ??
    options.find((option) => !option.disabled)?.value ??
    ""
  );
}
