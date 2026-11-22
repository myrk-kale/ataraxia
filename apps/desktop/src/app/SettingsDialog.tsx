import { X } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { PROVIDER_LABELS } from "../lib/agent";
import type { ProviderKind } from "../lib/workspace";
import { Button } from "../ui/Button";
import { Dialog, Toggle } from "../ui/Overlay";
import { play, useSound } from "./sound/sound";
import { AppearanceSettings, SettingRow } from "./appearance/AppearanceSettings";
import { ProfileSettings } from "./ProfileSettings";
import { AutocompletePanel } from "./AutocompleteSettings";
import { VoicePanel } from "./VoiceSettings";
import { ResourcesSettings } from "./ResourcesSettings";
import { MemoryPanel } from "../memory/MemoryPanel";
import type { WorkspaceName } from "../memory/MemoryEditor";
import type { RepositoryId, WorkspaceId } from "../lib/workspace";

const TABS = [
  { id: "appearance", label: "Appearance" },
  { id: "profiles", label: "Agent profiles" },
  { id: "resources", label: "Skills & MCP" },
  { id: "memory", label: "Memory" },
  { id: "autocomplete", label: "Autocomplete" },
  { id: "voice", label: "Voice" },
  { id: "sound", label: "Sound" },
  { id: "privacy", label: "Privacy" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function SettingsDialog({
  isOpen,
  provider,
  workspace = null,
  repository = null,
  workspaces = [],
  onOpenMemoryGraph,
  onClose,
}: {
  isOpen: boolean;
  provider: ProviderKind | null;
  /** The workspace and repository the app is looking at: the scopes the skills manager can edit besides global. */
  workspace?: { id: WorkspaceId; name: string } | null;
  repository?: { id: RepositoryId; name: string } | null;
  /** Every workspace, so a memory can be put in one and its scope read by name. */
  workspaces?: readonly WorkspaceName[];
  /** Closes Settings and opens the graph of memories. */
  onOpenMemoryGraph?: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabId>("appearance");
  const sound = useSound();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Up and Down (or Left and Right when the list lies flat) move between sections, as in any tab list.
  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
    if (!forward && !back) {
      return;
    }
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tab);
    const next = TABS[(index + (forward ? 1 : TABS.length - 1)) % TABS.length]!;
    setTab(next.id);
    tabRefs.current[next.id]?.focus();
  }

  return (
    <Dialog className="w-[min(800px,94vw)] max-w-none gap-0 p-0" isOpen={isOpen} label="Settings" size="lg" onClose={onClose}>
      <div className="flex h-[min(620px,84vh)] flex-col">
        <header className="flex flex-none items-center justify-between gap-4 border-b border-cg-line py-3 pr-4 pl-6">
          <h2 className="text-heading font-semibold text-cg-ink">Settings</h2>
          <Button aria-label="Close settings" variant="icon" onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <div
            aria-label="Settings sections"
            aria-orientation="vertical"
            className="flex flex-none gap-1 overflow-x-auto border-b border-cg-line p-3 sm:w-44 sm:flex-col sm:border-r sm:border-b-0"
            role="tablist"
            onKeyDown={onTabKey}
          >
            {TABS.map((item) => (
              <button
                key={item.id}
                ref={(node) => {
                  tabRefs.current[item.id] = node;
                }}
                aria-controls={`settings-${item.id}`}
                aria-selected={tab === item.id}
                className={`rounded-cg-md px-3 py-2 text-left text-ui whitespace-nowrap ${
                  tab === item.id
                    ? "bg-cg-tint font-semibold text-cg-ink"
                    : "text-cg-muted-strong hover:bg-cg-tint hover:text-cg-ink"
                }`}
                id={`settings-tab-${item.id}`}
                role="tab"
                tabIndex={tab === item.id ? 0 : -1}
                type="button"
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div
            aria-labelledby={`settings-tab-${tab}`}
            className="@container min-h-0 min-w-0 flex-1 overflow-y-auto p-6"
            id={`settings-${tab}`}
            role="tabpanel"
          >
            {tab === "appearance" ? <AppearanceSettings /> : null}

            {tab === "profiles" ? <ProfileSettings /> : null}

            {tab === "resources" ? <ResourcesSettings repository={repository} workspace={workspace} /> : null}

            {tab === "memory" ? (
              <MemoryPanel
                currentWorkspaceId={workspace?.id ?? null}
                workspaces={workspaces}
                onOpenGraph={() => {
                  onClose();
                  onOpenMemoryGraph?.();
                }}
              />
            ) : null}

            {tab === "autocomplete" ? <AutocompletePanel /> : null}

            {tab === "voice" ? <VoicePanel /> : null}

            {tab === "sound" ? (
              <>
                <SettingRow
                  hint="A light tick when you change space or choose a model, and a chime when the agent asks for approval. Nothing else makes a sound."
                  title="Sound effects"
                >
                  <Toggle
                    hideLabel
                    isSelected={sound.enabled}
                    label="Play sounds"
                    onChange={(enabled) => {
                      sound.set({ enabled });
                      if (enabled) {
                        play("tick");
                      }
                    }}
                  />
                </SettingRow>
                <SettingRow hint="Quiet by design; this only sets how quiet." title="Volume">
                  <input
                    aria-label="Sound volume"
                    aria-valuetext={`${Math.round(sound.volume * 100)} percent`}
                    className="h-1.5 w-40 cursor-pointer accent-[var(--cg-ink)] disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!sound.enabled}
                    max={1}
                    min={0}
                    step={0.05}
                    type="range"
                    value={sound.volume}
                    onChange={(event) => sound.set({ volume: Number(event.target.value) })}
                    onKeyUp={() => play("tick")}
                    onPointerUp={() => play("tick")}
                  />
                  <span className="w-10 text-right text-small text-cg-muted-strong tabular-nums">{Math.round(sound.volume * 100)}%</span>
                </SettingRow>
              </>
            ) : null}

            {tab === "privacy" ? (
              <SettingRow
                hint={
                  <>
                    The review queue is computed on this machine from the syntax tree and git. Decisions, diagrams and BTW
                    questions run only when you start them, on the provider you pick
                    {provider ? ` (this chat uses ${PROVIDER_LABELS[provider]})` : ""}, and that provider then receives the diff. Dictation runs on this computer, and the recording is deleted once it is text.
                  </>
                }
                title="Nothing is sent by itself"
              >
                {null}
              </SettingRow>
            ) : null}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
