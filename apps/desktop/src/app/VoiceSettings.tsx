import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { SpeechModelDialog } from "../chat/SpeechModelDialog";
import { speechSet, speechStatus, type SpeechStatus } from "../lib/speech";
import { Button } from "../ui/Button";
import { QuietSelect } from "../ui/QuietSelect";
import { SettingRow } from "./appearance/AppearanceSettings";

function problemText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const FIELD =
  "w-full rounded-cg-md border border-cg-control bg-cg-panel px-3 py-1.5 font-mono text-small text-cg-ink focus:border-cg-ink";

/**
 * Dictation in the message field. Whisper (the turbo model) is built into Ataraxia and runs on this
 * computer; only its model is downloaded, once. A command of one's own can take its place.
 */
export function VoicePanel() {
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [command, setCommand] = useState("");
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    speechStatus().then(
      (found) => {
        setStatus(found);
        setCommand(found.command);
      },
      (err: unknown) => setFailed(problemText(err)),
    );
  }, []);

  if (failed) {
    return <p className="text-small text-cg-del-fg">Could not read the voice settings: {failed}</p>;
  }
  if (!status) {
    return null;
  }

  async function save(nextCommand: string, language: string) {
    try {
      const next = await speechSet(nextCommand, language);
      setStatus(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (err) {
      setFailed(problemText(err));
    }
  }

  const custom = status.command.trim() !== "";
  return (
    <>
      <SettingRow
        hint="The microphone button in the message field (Ctrl/⌘ Shift M) records, and writes what you said into the field. Whisper, the turbo model, is built in and runs on this computer; the recording is never sent anywhere."
        title="Dictation"
      >
        <span className={`text-small ${status.ready ? "text-cg-green" : "text-cg-amber-text"}`} role="status">
          {status.ready ? "Ready" : status.needs_model ? "Needs its model" : "Not available"}
        </span>
      </SettingRow>
      {status.problem ? (
        <p className="mb-4 rounded-cg-md bg-cg-tint px-3.5 py-2.5 text-small leading-5 text-cg-muted-strong">{status.problem}</p>
      ) : null}
      {custom ? null : (
        <SettingRow
          hint={
            status.needs_model
              ? `The model is about ${status.model_megabytes} MB, downloaded once from huggingface.co and kept on this computer.`
              : "The model is on this computer."
          }
          title="Speech model"
        >
          {status.needs_model ? (
            <Button variant="primary" onClick={() => setDownloading(true)}>
              <Download aria-hidden="true" size={14} />
              Download {status.model_megabytes} MB
            </Button>
          ) : (
            <span className="text-small text-cg-muted-strong">Downloaded</span>
          )}
        </SettingRow>
      )}
      <SettingRow hint="What you dictate in. Detecting it works for most speech; pick one if short phrases are misheard." title="Language">
        <div className="rounded-cg-md border border-cg-control bg-cg-panel px-1">
          <QuietSelect
            aria-label="Dictation language"
            className="min-w-[11rem] px-2 py-1.5 text-ui text-cg-ink"
            options={status.languages.map((item) => ({ value: item.code === "" ? "auto" : item.code, label: item.name }))}
            searchable
            value={status.language === "" ? "auto" : status.language}
            onChange={(code) => void save(status.command, code === "auto" ? "" : code)}
          />
        </div>
      </SettingRow>
      <SettingRow
        hint="Optional. Leave empty to use the built-in Whisper. Or write a command that listens in its place: {file} stands for the recording, and the command prints the text."
        title="Your own command"
        below={
          <input
            aria-label="Speech command"
            autoComplete="off"
            className={FIELD}
            placeholder="whisper-cli -m ~/models/ggml-large-v3-turbo.bin -nt -f {file}"
            spellCheck={false}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
          />
        }
      >
        {null}
      </SettingRow>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => void save(command, status.language)}>
          {saved ? "Saved" : "Save"}
        </Button>
      </div>
      <SpeechModelDialog
        isOpen={downloading}
        megabytes={status.model_megabytes}
        onClose={() => setDownloading(false)}
        onReady={() => {
          setDownloading(false);
          void speechStatus().then(setStatus);
        }}
      />
    </>
  );
}
