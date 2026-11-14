import type { ProviderKind } from "../lib/workspace";
import { useActiveProfile, type HarnessProfile } from "../lib/profiles";
import { Tip } from "../ui/Overlay";
import { ProviderMark } from "./ProviderMark";

/**
 * A harness's mark, with a soft blur of the active profile's colour behind it when one is
 * chosen, and the profile's name on hover. The default way of starting has no glow and nothing
 * to say, so with no profile this is the plain mark. The colour is only a quick sign: the name
 * is also read out, shown in the usage details and listed in the settings.
 */
export function ProfileMark({ provider, size = 24 }: { provider: ProviderKind; size?: number }) {
  return <ProfileMarkView profile={useActiveProfile(provider)} provider={provider} size={size} />;
}

/** The mark for a given profile (or none), without reading the app's state. */
export function ProfileMarkView({
  provider,
  profile,
  size = 24,
}: {
  provider: ProviderKind;
  profile: Pick<HarnessProfile, "name" | "color"> | null;
  size?: number;
}) {
  if (!profile) {
    return <ProviderMark provider={provider} size={size} />;
  }
  return (
    <Tip label={profile.name}>
      <span className="relative inline-grid flex-none place-items-center" style={{ width: size, height: size }}>
        <span
          aria-hidden="true"
          className="absolute rounded-full"
          data-profile-glow={profile.color}
          style={{
            // A soft halo that hugs the mark and reaches a few pixels past it: a sign to notice
            // when looking, not a stain on the interface.
            inset: -Math.round(size * 0.06),
            background: profile.color,
            filter: `blur(${Math.round(size * 0.18)}px)`,
            opacity: 0.4,
          }}
        />
        <span className="relative grid place-items-center">
          <ProviderMark provider={provider} size={size} />
        </span>
        <span className="sr-only">Profile: {profile.name}</span>
      </span>
    </Tip>
  );
}
