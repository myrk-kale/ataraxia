import { Bot, Brain, Cpu } from "lucide-react";
import { useState } from "react";
import type { ProviderDescriptor, SessionOptions } from "../lib/agent";
import { QuietSelect, type SelectOption } from "../ui/QuietSelect";
import { effortAfterModelChange, effortsFor, modelChoices } from "./options";

const DEFAULT = "";

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

function CustomModelInput({ onSubmit }: { onSubmit: (model: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <input
      aria-label="Custom model id"
      className="w-full rounded-lg border border-cg-line bg-cg-tint px-2.5 py-2 text-small text-cg-ink outline-none placeholder:text-cg-muted/70 focus:border-cg-line-strong"
      placeholder="Custom model id ↵"
      spellCheck={false}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        // Keep arrow keys and typing inside the field instead of the list navigation.
        event.stopPropagation();
        if (event.key === "Enter" && draft.trim()) {
          event.preventDefault();
          onSubmit(draft.trim());
        }
      }}
    />
  );
}

/** Agent, model and reasoning-effort pickers shown at the right of the composer. */
export function SessionSettings({
  provider,
  options,
  model,
  effort,
  agent,
  disabled,
  disabledReason,
  onChange,
}: {
  provider: ProviderDescriptor | null;
  options: SessionOptions | null;
  model: string | null;
  effort: string | null;
  agent: string | null;
  disabled: boolean;
  disabledReason?: string;
  onChange: (model: string | null, effort: string | null, agent: string | null) => void;
}) {
  const settings = provider?.settings;
  if (!settings || !settings.configurable) {
    return (
      <span
        className="text-small text-cg-muted"
        title="Concierge cannot change the model, effort or agent for this provider."
      >
        Model set by the provider
      </span>
    );
  }

  const models = modelChoices(provider, options);
  const modelOptions: SelectOption[] = [
    { value: DEFAULT, label: "Default model", display: "Default" },
    ...models.map((item) => ({ value: item.id, label: item.label })),
  ];
  if (model && !modelOptions.some((option) => option.value === model)) {
    modelOptions.push({ value: model, label: model });
  }

  const efforts = effortsFor(provider, options, model);
  const effortOptions: SelectOption[] = [
    { value: DEFAULT, label: "Default effort", display: "Default" },
    ...efforts.map((item) => ({ value: item, label: effortLabel(item) })),
  ];
  if (effort && !effortOptions.some((option) => option.value === effort)) {
    effortOptions.push({ value: effort, label: effortLabel(effort) });
  }

  const agents = options?.agents ?? [];
  const agentOptions: SelectOption[] = [
    { value: DEFAULT, label: "Default agent", display: "Default" },
    ...agents.map((item) => ({
      value: item.id,
      label: item.label,
      hint: item.description ?? undefined,
    })),
  ];
  if (agent && !agentOptions.some((option) => option.value === agent)) {
    agentOptions.push({ value: agent, label: agent });
  }

  return (
    <div className="flex items-center gap-3 text-small text-cg-muted-strong">
      {settings.agents && agents.length > 0 ? (
        <QuietSelect
          aria-label="Agent"
          className="max-w-[140px]"
          disabled={disabled}
          icon={<Bot size={12} />}
          options={agentOptions}
          searchable
          title={disabled ? disabledReason : "Agent"}
          value={agent ?? DEFAULT}
          onChange={(value) => onChange(model, effort, value || null)}
        />
      ) : null}
      <QuietSelect
        aria-label="Model"
        className="max-w-[170px]"
        disabled={disabled}
        footer={
          settings.custom_model
            ? (close) => (
                <CustomModelInput
                  onSubmit={(value) => {
                    close();
                    onChange(value, effortAfterModelChange(provider, options, value, effort), agent);
                  }}
                />
              )
            : undefined
        }
        icon={<Cpu size={12} />}
        options={modelOptions}
        searchable
        title={disabled ? disabledReason : "Model"}
        value={model ?? DEFAULT}
        onChange={(value) => {
          const next = value || null;
          onChange(next, effortAfterModelChange(provider, options, next, effort), agent);
        }}
      />
      {efforts.length > 0 || effort ? (
        <QuietSelect
          aria-label="Reasoning effort"
          className="max-w-[130px]"
          disabled={disabled}
          icon={<Brain size={12} />}
          options={effortOptions}
          title={disabled ? disabledReason : "Reasoning effort"}
          value={effort ?? DEFAULT}
          onChange={(value) => onChange(model, value || null, agent)}
        />
      ) : null}
    </div>
  );
}
