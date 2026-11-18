import { Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  listenDownload,
  progressPercent,
  progressText,
  speechDownload,
  speechDownloadCancel,
  type DownloadProgress,
} from "../lib/speech";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Overlay";

function problemText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dictation listens with Whisper, which is built into the app, but its model is a download of
 * about half a gigabyte. It is fetched once, only after the person agrees, and kept on this
 * computer; an interrupted download picks up where it stopped.
 */
export function SpeechModelDialog({
  isOpen,
  megabytes,
  onClose,
  onReady,
}: {
  isOpen: boolean;
  megabytes: number;
  onClose: () => void;
  /** The model is on disk: dictation can start. */
  onReady: () => void;
}) {
  const [phase, setPhase] = useState<"ask" | "downloading" | "failed">("ask");
  const [progress, setProgress] = useState<DownloadProgress>({ received: 0, total: null });
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setPhase("ask");
      setProgress({ received: 0, total: null });
      setProblem(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (phase !== "downloading") {
      return;
    }
    let live = true;
    let stop: (() => void) | null = null;
    void listenDownload((next) => live && setProgress(next)).then((unlisten) => {
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
  }, [phase]);

  async function download() {
    setPhase("downloading");
    setProblem(null);
    try {
      await speechDownload();
      onReady();
    } catch (err) {
      setProblem(problemText(err));
      setPhase("failed");
    }
  }

  function close() {
    if (phase === "downloading") {
      void speechDownloadCancel();
    }
    onClose();
  }

  const percent = progressPercent(progress);
  return (
    <Dialog isOpen={isOpen} label="Speech model" size="md" onClose={close}>
      <div className="flex flex-col gap-4 p-6">
        <h2 className="text-heading font-semibold text-cg-ink">Download the speech model</h2>
        <p className="text-ui leading-6 text-cg-muted-strong">
          Dictation turns your voice into text with Whisper, which runs inside Ataraxia, on this computer. It needs its
          model: about {megabytes} MB, downloaded once from huggingface.co and kept here. What you say is never sent
          anywhere.
        </p>
        {phase === "downloading" ? (
          <div className="flex flex-col gap-2" role="status">
            <div
              aria-label="Download progress"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={percent ?? undefined}
              className="h-1.5 overflow-hidden rounded-full bg-cg-line"
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-cg-accent transition-[width]"
                style={{ width: `${percent ?? 8}%` }}
              />
            </div>
            <p className="flex items-center gap-2 text-small text-cg-muted-strong">
              <Loader2 aria-hidden="true" className="animate-spin" size={13} />
              Downloading… {progressText(progress)}
              {percent !== null ? ` (${percent}%)` : ""}
            </p>
          </div>
        ) : null}
        {problem ? (
          <p className="text-small text-cg-red" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={close}>
            {phase === "downloading" ? "Cancel" : "Not now"}
          </Button>
          {phase !== "downloading" ? (
            <Button variant="primary" onClick={() => void download()}>
              <Download aria-hidden="true" size={14} />
              {phase === "failed" ? "Try again" : `Download ${megabytes} MB`}
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
