import { AlertCircle, Check, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { PROVIDER_LABELS } from "../lib/agent";
import {
  PROFILE_COLORS,
  checkProfile,
  deleteProfile,
  nextColor,
  profilesOf,
  saveProfile,
  setActiveProfile,
  useProfiles,
  type HarnessProfile,
  type ProfileCheck,
} from "../lib/profiles";
import type { ProviderKind } from "../lib/workspace";
import { ProviderMark } from "../chat/ProviderMark";
import { Button } from "../ui/Button";

/** The harnesses that can have profiles: the demo provider has nothing to start. */
const HARNESSES: readonly ProviderKind[] = ["claude", "codex", "opencode"];

const COLOR_NAMES: Record<string, string> = {
  "#3b82f6": "Blue",
  "#22c55e": "Green",
  "#f59e0b": "Amber",
  "#ef4444": "Red",
  "#8b5cf6": "Violet",
  "#ec4899": "Pink",
  "#14b8a6": "Teal",
  "#f97316": "Orange",
};

const EXAMPLE: Record<ProviderKind, string> = {
  claude: "CLAUDE_CONFIG_DIR=~/.claude-work claude",
  codex: "CODEX_HOME=~/.codex-work codex",
  opencode: "XDG_DATA_HOME=~/.opencode-work opencode",
  fake: "",
};

const FIELD =
  "h-8 w-full rounded-cg-md border border-cg-control bg-cg-panel px-2.5 text-ui text-cg-ink placeholder:text-cg-muted";

/** What the command would run, asked of the app a moment after the typing stops. */
function useCheck(command: string): ProfileCheck | null {
  const [result, setResult] = useState<{ command: string; check: ProfileCheck } | null>(null);
  useEffect(() => {
    if (command.trim() === "") {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      checkProfile(command).then(
        (check) => {
          if (!cancelled) {
            setResult({ command, check });
          }
        },
        () => undefined,
      );
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [command]);
  // An answer for text that has since changed is not an answer.
  return result && result.command === command ? result.check : null;
}

function ProfileForm({
  provider,
  initial,
  takenColors,
  onDone,
}: {
  provider: ProviderKind;
  initial: HarnessProfile | null;
  takenColors: string[];
  onDone: () => void;
}) {
  const ids = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState(initial?.color ?? nextColor(takenColors));
  const [command, setCommand] = useState(initial?.command ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const check = useCheck(command);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await saveProfile({ id: initial?.id ?? "", provider, name, color, command });
      onDone();
    } catch (reason) {
      setError(typeof reason === "string" ? reason : String(reason));
      setSaving(false);
    }
  }

  return (
    <form
      aria-label={initial ? `Edit ${initial.name}` : `New ${PROVIDER_LABELS[provider]} profile`}
      className="mt-2 grid gap-3 rounded-cg-lg border border-cg-line bg-cg-tint p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Closes the form and nothing behind it: the dialog stays open.
          event.stopPropagation();
          onDone();
        }
      }}
    >
      <div className="grid gap-1">
        <label className="text-small font-medium text-cg-ink" htmlFor={`${ids}-name`}>
          Name
        </label>
        <input
          autoFocus
          className={FIELD}
          id={`${ids}-name`}
          maxLength={40}
          placeholder="Work"
          spellCheck={false}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
      </div>

      <fieldset className="grid gap-1.5">
        <legend className="text-small font-medium text-cg-ink">Colour</legend>
        <div className="flex flex-wrap gap-2">
          {PROFILE_COLORS.map((swatch) => (
            <label key={swatch} className="relative cursor-pointer">
              <input
                checked={color === swatch}
                className="peer sr-only"
                name={`${ids}-color`}
                type="radio"
                value={swatch}
                onChange={() => setColor(swatch)}
              />
              <span className="sr-only">{COLOR_NAMES[swatch]}</span>
              <span
                aria-hidden="true"
                className="grid h-6 w-6 place-items-center rounded-full ring-offset-2 ring-offset-[var(--cg-tint)] peer-checked:ring-2 peer-checked:ring-[var(--cg-ink)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--cg-accent)]"
                style={{ background: swatch }}
              >
                {color === swatch ? <Check className="text-white mix-blend-difference" size={13} /> : null}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-1">
        <label className="text-small font-medium text-cg-ink" htmlFor={`${ids}-command`}>
          Command
        </label>
        <input
          aria-describedby={`${ids}-help`}
          className={`${FIELD} font-mono`}
          id={`${ids}-command`}
          placeholder={EXAMPLE[provider]}
          spellCheck={false}
          value={command}
          onChange={(event) => {
            setCommand(event.target.value);
            setError(null);
          }}
        />
        <p className="text-small leading-5 text-cg-muted-strong" id={`${ids}-help`}>
          Written as in a terminal: settings first (usually the variable that points the agent at
          another account&apos;s folder), then the program and its arguments. Leave the program out to
          use the usual one. <code className="font-mono">~</code> is your home folder; nothing else is
          expanded, and nothing runs until a chat starts.
        </p>
        {check ? (
          <p
            className={`flex items-center gap-1.5 text-small ${check.ok ? "text-cg-muted-strong" : "text-cg-del-fg"}`}
            role="status"
          >
            {check.ok ? <Check aria-hidden="true" size={13} /> : <AlertCircle aria-hidden="true" size={13} />}
            {check.message}
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="flex items-center gap-1.5 text-small text-cg-del-fg" role="alert">
          <AlertCircle aria-hidden="true" size={13} />
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button disabled={saving} size="sm" type="submit" variant="primary">
          {initial ? "Save" : "Add profile"}
        </Button>
        <Button size="sm" variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Choice({
  group,
  checked,
  title,
  detail,
  swatch,
  mono = false,
  onChoose,
  actions,
}: {
  group: string;
  checked: boolean;
  title: string;
  detail: string;
  swatch?: string;
  /** The detail is a command, so it is set in the code face. */
  mono?: boolean;
  onChoose: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-cg-md border px-3 py-2.5 ${
        checked ? "border-cg-line-strong bg-cg-tint" : "border-transparent hover:bg-cg-tint"
      }`}
    >
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
        <input
          checked={checked}
          className="h-3.5 w-3.5 flex-none cursor-pointer accent-[var(--cg-ink)]"
          name={group}
          type="radio"
          onChange={onChoose}
        />
        {swatch ? (
          <span aria-hidden="true" className="h-3 w-3 flex-none rounded-full" style={{ background: swatch }} />
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2 text-ui font-medium text-cg-ink">
            {title}
            {checked ? <span className="text-small font-normal text-cg-muted-strong">In use</span> : null}
          </span>
          <span className={`truncate text-small text-cg-muted-strong ${mono ? "font-mono" : ""}`}>{detail}</span>
        </span>
      </label>
      {actions}
    </div>
  );
}

function HarnessSection({ provider }: { provider: ProviderKind }) {
  const all = useProfiles();
  const profiles = profilesOf(all, provider);
  const activeId = all.active[provider] ?? null;
  const group = useId();
  // `new` is the form for a profile that does not exist yet; an id is the form for that one.
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const label = PROVIDER_LABELS[provider];
  const editingProfile = editing && editing !== "new" ? (profiles.find((item) => item.id === editing) ?? null) : null;

  async function choose(id: string | null) {
    setProblem(null);
    try {
      await setActiveProfile(provider, id);
    } catch (reason) {
      setProblem(String(reason));
    }
  }

  return (
    <section aria-labelledby={`${group}-title`} className="border-b border-cg-line py-5 first:pt-0 last:border-b-0">
      <h4 className="mb-2 flex items-center gap-2 text-ui font-semibold text-cg-ink" id={`${group}-title`}>
        <ProviderMark provider={provider} size={18} />
        {label}
      </h4>
      <div aria-labelledby={`${group}-title`} className="grid gap-1" role="radiogroup">
        <Choice
          checked={activeId === null}
          detail="Starts it the way it is installed"
          group={group}
          title="Default"
          onChoose={() => void choose(null)}
        />
        {profiles.map((profile) => (
          <Choice
            key={profile.id}
            actions={
              confirming === profile.id ? (
                <span className="flex flex-none items-center gap-1.5">
                  <Button
                    aria-label={`Delete ${profile.name} for good`}
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setConfirming(null);
                      void deleteProfile(profile.id).catch((reason) => setProblem(String(reason)));
                    }}
                  >
                    Delete
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => setConfirming(null)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <span className="flex flex-none items-center gap-0.5">
                  <Button
                    aria-label={`Edit ${profile.name}`}
                    variant="icon"
                    onClick={() => {
                      setConfirming(null);
                      setEditing(profile.id);
                    }}
                  >
                    <Pencil size={13} />
                  </Button>
                  <Button aria-label={`Delete ${profile.name}`} variant="icon" onClick={() => setConfirming(profile.id)}>
                    <Trash2 size={13} />
                  </Button>
                </span>
              )
            }
            checked={activeId === profile.id}
            detail={profile.command}
            group={group}
            mono
            swatch={profile.color}
            title={profile.name}
            onChoose={() => void choose(profile.id)}
          />
        ))}
      </div>
      {problem ? (
        <p className="mt-2 text-small text-cg-del-fg" role="alert">
          {problem}
        </p>
      ) : null}
      {editing ? (
        <ProfileForm
          key={editing}
          initial={editingProfile}
          provider={provider}
          takenColors={profiles.map((item) => item.color)}
          onDone={() => setEditing(null)}
        />
      ) : (
        <Button className="mt-2" size="sm" variant="quiet" onClick={() => setEditing("new")}>
          <Plus aria-hidden="true" size={13} />
          Add a {label} profile
        </Button>
      )}
    </section>
  );
}

/**
 * The ways each harness can be started. A profile is a command (usually the settings that point
 * the harness at another account) with a name and a colour; the one in use is chosen here, and
 * shows as a glow behind the harness's mark in the chat.
 */
export function ProfileSettings() {
  return (
    <div>
      <p className="mb-5 text-small leading-5 text-cg-muted-strong">
        A profile is a way of starting an agent, usually another account. The one in use starts
        every new chat, and a chat that is already open switches to it at its next message (the new
        agent is told where the conversation so far is kept). The profile in use shows as a glow
        behind the agent&apos;s mark; hover it for the name.
      </p>
      {HARNESSES.map((provider) => (
        <HarnessSection key={provider} provider={provider} />
      ))}
    </div>
  );
}
