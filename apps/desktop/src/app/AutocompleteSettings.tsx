import { useEffect, useState } from "react";
import {
  autocompleteForget,
  autocompleteLanguages,
  autocompleteSetSettings,
  autocompleteSettings,
  type AutocompleteLanguage,
  type AutocompleteSettings as Settings,
} from "../lib/agent";
import { Button } from "../ui/Button";
import { Toggle } from "../ui/Overlay";
import { QuietSelect } from "../ui/QuietSelect";
import { SettingRow } from "./appearance/AppearanceSettings";

const NONE = "none";

/** Autocomplete of the message field: which languages it knows and what it learns from. */
export function AutocompletePanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [languages, setLanguages] = useState<AutocompleteLanguage[]>([]);
  const [forgotten, setForgotten] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    // The system's language picks the starting point the first time; after that the choice is stored.
    Promise.all([autocompleteSettings(navigator.language), autocompleteLanguages()]).then(
      ([loaded, available]) => {
        setSettings(loaded);
        setLanguages(available);
      },
      (error: unknown) => setFailed(String(error)),
    );
  }, []);

  if (failed) {
    return <p className="text-small text-cg-del-fg">Could not read the autocomplete settings: {failed}</p>;
  }
  if (!settings) {
    return null;
  }

  function change(next: Partial<Settings>) {
    const merged = { ...settings!, ...next };
    setSettings(merged);
    autocompleteSetSettings(merged).then(setSettings, (error: unknown) => setFailed(String(error)));
  }

  const [primary = "en", secondary = NONE] = settings.languages;
  const options = languages.map((language) => ({ value: language.code, label: language.name }));
  const off = !settings.enabled;

  function pickLanguages(first: string, second: string) {
    change({ languages: second === NONE || second === first ? [first] : [first, second] });
  }

  return (
    <>
      <SettingRow
        hint="Suggests the rest of a word, or a whole phrase, in grey as you type. Tab or the right arrow accepts it."
        title="Autocomplete"
      >
        <Toggle hideLabel isSelected={settings.enabled} label="Autocomplete" onChange={(enabled) => change({ enabled })} />
      </SettingRow>
      <SettingRow hint="The words it knows before it has learned anything from you." title="Language">
        <div className="rounded-cg-md border border-cg-control bg-cg-panel px-1">
          <QuietSelect
            aria-label="Language"
            className="min-w-[11rem] px-2 py-1.5 text-ui text-cg-ink"
            disabled={off}
            options={options}
            searchable
            value={primary}
            onChange={(code) => pickLanguages(code, secondary)}
          />
        </div>
      </SettingRow>
      <SettingRow hint="For when you write in two languages, such as your own and English." title="Second language">
        <div className="rounded-cg-md border border-cg-control bg-cg-panel px-1">
          <QuietSelect
            aria-label="Second language"
            className="min-w-[11rem] px-2 py-1.5 text-ui text-cg-ink"
            disabled={off}
            options={[{ value: NONE, label: "None" }, ...options.filter((option) => option.value !== primary)]}
            searchable
            value={secondary}
            onChange={(code) => pickLanguages(primary, code)}
          />
        </div>
      </SettingRow>
      <SettingRow hint="Offers the words you usually write after the ones you just wrote, not only the end of one." title="Phrases">
        <Toggle hideLabel isDisabled={off} isSelected={settings.phrases} label="Suggest phrases" onChange={(phrases) => change({ phrases })} />
      </SettingRow>
      <SettingRow
        hint="Offers the names of functions, classes and types the syntax analyzer finds in this chat's repositories."
        title="Names from the code"
      >
        <Toggle hideLabel isDisabled={off} isSelected={settings.symbols} label="Suggest names from the code" onChange={(symbols) => change({ symbols })} />
      </SettingRow>
      <SettingRow
        hint="It learns from the messages you send, in every chat, and keeps it on this machine. Code, paths, links and what looks like a key are left out, and so is anything an agent writes."
        title="Learn from what I write"
      >
        <Toggle hideLabel isDisabled={off} isSelected={settings.learn} label="Learn from what I write" onChange={(learn) => change({ learn })} />
      </SettingRow>
      <SettingRow hint="Starts the learning over. The dictionaries stay." title="Forget what it learned">
        <Button
          size="sm"
          variant="quiet"
          onClick={() => {
            autocompleteForget().then(
              () => setForgotten(true),
              (error: unknown) => setFailed(String(error)),
            );
          }}
        >
          {forgotten ? "Forgotten" : "Forget"}
        </Button>
      </SettingRow>
    </>
  );
}
