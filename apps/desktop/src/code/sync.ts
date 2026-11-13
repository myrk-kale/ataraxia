/**
 * Turns the bursts of "the files changed" that the core pushes into few reloads: one after things
 * go quiet, at most one every `maxWaitMs` while they keep changing, and none while nothing can be
 * seen (a hidden window, another space in front). A change that arrived meanwhile is run as soon
 * as `resume` says it can be seen again.
 */
export type SyncScheduler = {
  /** Something changed. */
  request: () => void;
  /** It may be visible again: runs what was held back. */
  resume: () => void;
  dispose: () => void;
};

export function createSyncScheduler({
  run,
  canRun,
  quietMs = 600,
  maxWaitMs = 4000,
}: {
  run: () => void;
  canRun: () => boolean;
  quietMs?: number;
  maxWaitMs?: number;
}): SyncScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt = 0;
  let pending = false;
  let disposed = false;

  function fire() {
    timer = undefined;
    if (disposed || !pending) {
      return;
    }
    if (!canRun()) {
      // Held back: `resume` picks it up.
      return;
    }
    pending = false;
    firstAt = 0;
    run();
  }

  return {
    request() {
      if (disposed) {
        return;
      }
      pending = true;
      const now = Date.now();
      if (firstAt === 0) {
        firstAt = now;
      }
      clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, Math.min(quietMs, firstAt + maxWaitMs - now)));
    },
    resume() {
      if (disposed || !pending || timer !== undefined) {
        return;
      }
      timer = setTimeout(fire, 0);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
