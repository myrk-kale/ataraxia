import { useEffect, useState } from "react";
import { WAKE_OPTIONS, wakeMode, wakeSetMode, type WakeMode } from "../lib/wake";
import { QuietSelect } from "../ui/QuietSelect";
import { SettingRow } from "./appearance/AppearanceSettings";

export function WakePanel() {
  const [mode, setMode] = useState<WakeMode | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    wakeMode()
      .then((value) => live && setMode(value))
      .catch((err: unknown) => live && setProblem(String(err)));
    return () => {
      live = false;
    };
  }, []);

  function choose(next: WakeMode) {
    const before = mode;
    setMode(next);
    setProblem(null);
    wakeSetMode(next).catch((err: unknown) => {
      setMode(before);
      setProblem(String(err));
    });
  }

  return (
    <SettingRow
      below={
        problem ? (
          <p className="text-small text-cg-red" role="alert">
            {problem}
          </p>
        ) : null
      }
      hint="While an agent works, a message is queued, a schedule waits to fire or a background task runs, in any chat. When nothing is pending, the computer sleeps as usual. Computer only lets the screen turn off and lock."
      title="Keep awake while there is work"
    >
      <div className="rounded-cg-md border border-cg-control bg-cg-panel px-1">
        <QuietSelect
          aria-label="Keep awake while there is work"
          className="min-w-[13rem] px-2 py-1.5 text-ui text-cg-ink"
          disabled={mode === null}
          options={WAKE_OPTIONS}
          value={mode ?? "display"}
          onChange={(value) => choose(value as WakeMode)}
        />
      </div>
    </SettingRow>
  );
}
