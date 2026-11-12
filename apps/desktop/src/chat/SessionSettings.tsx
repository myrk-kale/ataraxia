import { Brain, Cpu } from "lucide-react";
import { useState } from "react";
import type { ProviderDescriptor } from "../lib/agent";
import { QuietSelect, type SelectOption } from "../ui/QuietSelect";

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

function CustomModelInput({
  onSubmit,
}: {
  onSubmit: (model: string) => void;
}) {
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

/** Model and reasoning-effort pickers shown at the right of the composer. */
export function SessionSettings({
  provider,
  model,
  effort,
  disabled,
  disabledReason,
  onChange,
}: {
  provider: ProviderDescriptor | null;
  model: string | null;
  effort: string | null;
  disabled: boolean;
  disabledReason?: string;
  onChange: (model: string | null, effort: string | null) => void;
}) {
  const settings = provider?.settings;
  if (!settings || !settings.configurable) {
    return (
      <span
        className="text-small text-cg-muted"
        title="Concierge cannot change the model or effort for this provider yet."
      >
        Model set by the provider
      </span>
    );
  }

  const modelOptions: SelectOption[] = [
    { value: DEFAULT, label: "Default model", display: "Default" },
    ...settings.models.map((item) => ({ value: item.id, label: item.label })),
  ];
  if (model && !modelOptions.some((option) => option.value === model)) {
    modelOptions.push({ value: model, label: model });
  }
  const effortOptions: SelectOption[] = [
    { value: DEFAULT, label: "Default effort", display: "Default" },
    ...settings.efforts.map((item) => ({ value: item, label: effortLabel(item) })),
  ];

  return (
    <div className="flex items-center gap-3 text-small text-cg-muted-strong">
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
                    onChange(value, effort);
                  }}
                />
              )
            : undefined
        }
        icon={<Cpu size={12} />}
        options={modelOptions}
        title={disabled ? disabledReason : "Model"}
        value={model ?? DEFAULT}
        onChange={(value) => onChange(value || null, effort)}
      />
      {settings.efforts.length > 0 ? (
        <QuietSelect
          aria-label="Reasoning effort"
          className="max-w-[130px]"
          disabled={disabled}
          icon={<Brain size={12} />}
          options={effortOptions}
          title={disabled ? disabledReason : "Reasoning effort"}
          value={effort ?? DEFAULT}
          onChange={(value) => onChange(model, value || null)}
        />
      ) : null}
    </div>
  );
}
