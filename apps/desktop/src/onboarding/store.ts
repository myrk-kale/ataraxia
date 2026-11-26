/**
 * Whether the welcome tour has been shown. The mark is kept in the window's storage with the
 * version of the tour, so a tour that is rewritten later can be shown again by raising the number,
 * and everybody who has used the app before this existed sees it once as well: they have no mark.
 */
export const ONBOARDING_VERSION = 1;
export const ONBOARDING_KEY = "ataraxia.onboarding.seen";

type Store = Pick<Storage, "getItem" | "setItem">;

function storage(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** True until the tour has been seen (or skipped) at the current version. */
export function shouldShowOnboarding(store: Store | null = storage()): boolean {
  if (!store) {
    // Without storage there is no way to remember it, and a tour on every start is a nuisance.
    return false;
  }
  try {
    const seen = Number(store.getItem(ONBOARDING_KEY));
    return !(Number.isFinite(seen) && seen >= ONBOARDING_VERSION);
  } catch {
    return false;
  }
}

export function markOnboardingSeen(store: Store | null = storage()): void {
  try {
    store?.setItem(ONBOARDING_KEY, String(ONBOARDING_VERSION));
  } catch {
    // Blocked storage: the tour comes back next time, which is the lesser harm.
  }
}
