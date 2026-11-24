import { Download, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  onUpdateProgress,
  progressPercent,
  updateCheck,
  updateInstall,
  UPDATE_FIRST_CHECK_MS,
  UPDATE_RECHECK_MS,
  type UpdateInfo,
  type UpdateProgress,
} from "../lib/update";
import { Button } from "../ui/Button";

type Phase = { kind: "idle" } | { kind: "installing"; progress: UpdateProgress | null } | { kind: "failed"; message: string };

/**
 * Offers the newer release the app finds, and when the person agrees downloads it, installs it and
 * restarts. It looks a moment after the app opens and again every few hours; it says nothing when
 * there is nothing new, when the look fails (offline) or when this copy cannot update itself.
 */
export function UpdatePrompt() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const installing = useRef(false);

  useEffect(() => {
    let live = true;
    function look() {
      if (installing.current) {
        return;
      }
      updateCheck()
        .then((found) => live && setUpdate(found))
        .catch(() => {
          // Offline or the release is not out yet: the next look tries again.
        });
    }
    const first = window.setTimeout(look, UPDATE_FIRST_CHECK_MS);
    const again = window.setInterval(look, UPDATE_RECHECK_MS);
    return () => {
      live = false;
      window.clearTimeout(first);
      window.clearInterval(again);
    };
  }, []);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | null = null;
    void onUpdateProgress((progress) => live && setPhase({ kind: "installing", progress })).then((unlisten) => {
      if (live) {
        stop = unlisten;
      } else {
        unlisten();
      }
    });
    return () => {
      live = false;
      stop?.();
    };
  }, []);

  function install() {
    installing.current = true;
    setPhase({ kind: "installing", progress: null });
    updateInstall().catch((err: unknown) => {
      installing.current = false;
      setPhase({ kind: "failed", message: String(err) });
    });
  }

  if (!update || dismissed === update.version) {
    return null;
  }

  const busy = phase.kind === "installing";
  const percent = phase.kind === "installing" && phase.progress ? progressPercent(phase.progress) : null;

  return (
    <section
      aria-label="Update available"
      className="absolute top-12 right-5.5 z-50 flex w-[360px] max-w-[calc(100%-2.75rem)] flex-col gap-3 rounded-cg-md border border-cg-line-strong bg-cg-float px-4 py-3 text-small leading-5 text-cg-ink shadow-cg-pop"
      role="status"
    >
      <div className="flex items-start gap-3">
        <Download aria-hidden="true" className="mt-0.5 flex-none text-cg-muted-strong" size={15} />
        <div className="min-w-0">
          <p className="font-semibold">Ataraxia {update.version} is available</p>
          <p className="text-cg-muted-strong">You have {update.current}. The app restarts to finish the update, and running agents stop.</p>
        </div>
      </div>
      {update.notes ? (
        <details className="text-cg-muted-strong">
          <summary className="cursor-pointer text-cg-ink">What is new</summary>
          <p className="mt-1 max-h-40 overflow-auto break-words whitespace-pre-wrap">{update.notes}</p>
        </details>
      ) : null}
      {busy ? (
        <div className="flex items-center gap-2">
          <progress
            aria-label="Downloading the update"
            className="h-1.5 min-w-0 flex-1"
            max={100}
            value={percent ?? undefined}
          />
          <span className="flex-none text-cg-muted-strong">{percent === null ? "Downloading…" : `${percent}%`}</span>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          {phase.kind === "failed" ? (
            <p className="mr-auto min-w-0 break-words text-cg-red" role="alert">
              {phase.message}
            </p>
          ) : null}
          <Button size="sm" variant="quiet" onClick={() => setDismissed(update.version)}>
            Later
          </Button>
          <Button size="sm" variant="primary" onClick={install}>
            <RefreshCw aria-hidden="true" size={13} />
            {phase.kind === "failed" ? "Try again" : "Update and restart"}
          </Button>
        </div>
      )}
    </section>
  );
}
