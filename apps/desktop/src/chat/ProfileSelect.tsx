import { Users } from "lucide-react";
import { profilesOf, useProfiles } from "../lib/profiles";
import type { ProviderKind } from "../lib/workspace";
import { QuietSelect, type SelectOption } from "../ui/QuietSelect";

const DEFAULT = "";

/**
 * Which profile (usually which account) this chat starts its harness with. It lives with the
 * provider and model pickers because it belongs to the chat, not to the whole app; the profiles
 * themselves are added and edited in the settings. Nothing is drawn for a harness with no profile,
 * since there would be nothing to choose.
 */
export function ProfileSelect({
  provider,
  value,
  disabled,
  disabledReason,
  onChange,
}: {
  provider: ProviderKind;
  value: string | null | undefined;
  disabled: boolean;
  disabledReason?: string;
  onChange: (profile: string | null) => void;
}) {
  const profiles = profilesOf(useProfiles(), provider);
  if (profiles.length === 0) {
    return null;
  }
  const options: SelectOption[] = [
    { value: DEFAULT, label: "Default", hint: "Starts it the way it is installed" },
    ...profiles.map((profile) => ({ value: profile.id, label: profile.name, hint: profile.command })),
  ];
  const chosen = profiles.find((profile) => profile.id === value) ?? null;
  return (
    <QuietSelect
      aria-label="Profile"
      sound
      className="max-w-[140px]"
      disabled={disabled}
      icon={
        chosen ? (
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: chosen.color }} />
        ) : (
          <Users size={12} />
        )
      }
      options={options}
      title={disabled ? disabledReason : "Profile for this chat: the next message goes out under it"}
      value={chosen ? chosen.id : DEFAULT}
      onChange={(next) => onChange(next || null)}
    />
  );
}
