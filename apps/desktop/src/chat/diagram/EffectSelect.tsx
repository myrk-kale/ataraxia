import { QuietSelect, type SelectOption } from "../../ui/QuietSelect";
import { EFFECTS, EFFECT_HINTS, EFFECT_LABELS, type EffectId } from "./effects";

export const EFFECT_OPTIONS: SelectOption[] = [
  { value: "none", label: "None, keep it still", display: "No animation" },
  ...EFFECTS.map((effect) => ({
    value: effect,
    label: EFFECT_LABELS[effect],
    display: EFFECT_LABELS[effect],
    hint: EFFECT_HINTS[effect],
  })),
];

/** Picks the animation of one diagram. */
export function EffectSelect({
  value,
  onChange,
  disabled = false,
  className = "",
}: {
  value: EffectId | "none";
  onChange: (effect: EffectId | "none") => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex h-[26px] items-center rounded-cg-sm border border-cg-line-strong bg-cg-panel px-1 ${className}`}>
      <QuietSelect
        aria-label="Animation of this diagram"
        className="px-1.5 py-0 text-small text-cg-muted-strong hover:text-cg-ink"
        disabled={disabled}
        options={EFFECT_OPTIONS}
        title={disabled ? "The system asks for less motion" : "Choose the animation of this diagram"}
        value={value}
        onChange={(effect) => onChange(effect as EffectId | "none")}
      />
    </div>
  );
}
