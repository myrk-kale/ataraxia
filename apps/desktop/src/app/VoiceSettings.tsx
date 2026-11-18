import { useEffect, useState } from "react";
import { speechSet, speechStatus, type SpeechStatus } from "../lib/speech";
import { Button } from "../ui/Button";
import { SettingRow } from "./appearance/AppearanceSettings";

function problemText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const FIELD =
  "w-full rounded-cg-md border border-cg-control bg-cg-panel px-3 py-1.5 font-mono text-small text-cg-ink focus:border-cg-ink";

/**
 * Dictation in the message field. Ataraxia does not bundle a speech model: it uses the Whisper
 * engine installed on this computer (the turbo model), and nothing is sent anywhere.
 */
export function VoicePanel() {
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [command, setCommand] = useState("");
  const [model, setModel] = useState("");
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    speechStatus().then(
      (found) => {
        setStatus(found);
        setCommand(found.command);
        setModel(found.model);
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

  async function save() {
    try {
      const next = await speechSet(command, model);
      setStatus(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (err) {
      setFailed(problemText(err));
    }
  }

  return (
    <>
      <SettingRow
        hint="The microphone button in the message field (Ctrl/⌘ Shift M) records, and writes what you said into the field. It listens with a Whisper engine on this computer; the recording is never sent anywhere."
        title="Dictation"
      >
        <span className={`text-small ${status.ready ? "text-cg-green" : "text-cg-amber-text"}`} role="status">
          {status.ready ? `Ready: ${status.engine}` : "No engine yet"}
        </span>
      </SettingRow>
      {status.problem ? (
        <p className="mb-4 rounded-cg-md bg-cg-tint px-3.5 py-2.5 text-small leading-5 text-cg-muted-strong">{status.problem}</p>
      ) : null}
      <SettingRow
        hint="Leave empty to use whichever is installed: whisper.cpp (whisper-cli), mlx-whisper or whisper, always with the turbo model. Or write your own: {file} stands for the recording, and the command prints the text."
        title="Command"
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
      <SettingRow
        hint={`For whisper.cpp: the model file. Empty looks in ~/.cache/whisper and the usual places for a large-v3-turbo model. Download it from ${status.model_url}`}
        title="Model file"
        below={
          <input
            aria-label="Speech model file"
            autoComplete="off"
            className={FIELD}
            placeholder="~/.cache/whisper/ggml-large-v3-turbo.bin"
            spellCheck={false}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        }
      >
        {null}
      </SettingRow>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => void save()}>
          {saved ? "Saved" : "Save"}
        </Button>
      </div>
    </>
  );
}
