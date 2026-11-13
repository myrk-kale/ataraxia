import { Minus, Plus } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../../ui/Button";
import { QuietSelect, type SelectOption } from "../../ui/QuietSelect";
import { AREAS, SIZE_LIMITS, type FontArea } from "./fonts";
import { installedFonts } from "./installedFonts";
import { BUILT_IN_THEMES, useAppearance, type Mode } from "./store";

const SWATCHES = ["--cg-canvas", "--cg-panel", "--cg-ink", "--cg-accent", "--cg-green", "--cg-red"] as const;

/** One setting: its name and a line about it on the left, its control on the right. */
export function SettingRow({
  title,
  hint,
  children,
  below,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-cg-line py-4 first:pt-0 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
          <h4 className="text-ui font-medium text-cg-ink">{title}</h4>
          {hint ? <p className="text-small leading-5 text-cg-muted-strong">{hint}</p> : null}
        </div>
        <div className="flex flex-none items-center gap-2">{children}</div>
      </div>
      {below}
    </div>
  );
}

const FIELD =
  "h-8 rounded-cg-md border border-cg-control bg-cg-panel text-ui text-cg-ink";

const DEFAULT_FACE: Record<FontArea, string> = {
  interface: "Geist",
  chat: "Geist",
  code: "Geist Mono",
  terminal: "Geist Mono",
};

function FontRow({ area, label, hint }: { area: FontArea; label: string; hint: string }) {
  const { fonts, setFont } = useAppearance();
  const setting = fonts[area];
  const limits = SIZE_LIMITS[area];
  const mono = area === "code" || area === "terminal";
  const step = (delta: number) => setFont(area, { size: setting.size + delta });
  // Only faces this machine has; one chosen earlier that is gone stays listed, so it can be seen and changed.
  const options = useMemo<SelectOption[]>(() => {
    const list = installedFonts(mono ? "mono" : "sans");
    const out: SelectOption[] = [{ value: "", label: `Default (${DEFAULT_FACE[area]})` }];
    out.push(...list.map((name) => ({ value: name, label: name })));
    if (setting.family && !list.includes(setting.family)) {
      out.push({ value: setting.family, label: `${setting.family} (not installed)` });
    }
    return out;
  }, [area, mono, setting.family]);
  return (
    <div className="grid grid-cols-1 items-center gap-x-4 gap-y-2 border-b border-cg-line py-3 last:border-b-0 @lg:grid-cols-[minmax(0,1fr)_12rem_7rem]">
      <div className="flex min-w-0 flex-col">
        <h4 className="text-ui font-medium text-cg-ink">{label}</h4>
        <p className="text-small leading-5 text-cg-muted-strong">{hint}</p>
      </div>
      <div className={`${FIELD} min-w-0 px-1`}>
        <QuietSelect
          aria-label={`${label} typeface`}
          className="w-full px-1.5 text-ui text-cg-ink"
          options={options}
          searchable={options.length > 8}
          value={setting.family}
          onChange={(family) => setFont(area, { family })}
        />
      </div>
      <div className={`${FIELD} flex w-28 items-center justify-between px-0.5 @lg:w-full`}>
        <Button aria-label={`Smaller ${label.toLowerCase()} text`} disabled={setting.size <= limits.min} variant="icon" onClick={() => step(-0.5)}>
          <Minus size={13} />
        </Button>
        <span aria-live="polite" className="text-center text-ui text-cg-ink tabular-nums">
          {setting.size}
        </span>
        <Button aria-label={`Larger ${label.toLowerCase()} text`} disabled={setting.size >= limits.max} variant="icon" onClick={() => step(0.5)}>
          <Plus size={13} />
        </Button>
      </div>
    </div>
  );
}

const MODES: { id: Mode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** Theme and typefaces: the two things that change how the whole app looks. */
export function AppearanceSettings() {
  const { themeId, mode, themes, imported, kind, setTheme, setMode, importThemes, removeTheme, resetFonts } = useAppearance();
  const picker = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<{ text: string; problem: boolean }[]>([]);

  const options: SelectOption[] = [
    ...BUILT_IN_THEMES.map((theme) => ({ value: theme.id, label: theme.name })),
    ...themes.map((theme) => ({ value: theme.id, label: `${theme.name} (VS Code)` })),
  ];
  const selected = options.some((option) => option.value === themeId) ? themeId : options[0]!.value;

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }
    const read = await Promise.all(Array.from(files).map(async (file) => ({ name: file.name, text: await file.text() })));
    const { added, errors } = importThemes(read);
    setNotice([
      ...added.map((theme) => ({ text: `Imported ${theme.name} (${theme.kind}).`, problem: false })),
      ...errors.map((text) => ({ text, problem: true })),
    ]);
    if (picker.current) {
      picker.current.value = "";
    }
  }

  const messages = [
    ...(imported ? imported.warnings.map((text) => ({ text, problem: false })) : []),
    ...notice,
  ];

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Theme" className="flex flex-col">
        <h3 className="mb-3 text-small font-semibold text-cg-muted-strong">Theme</h3>
        <SettingRow hint="Each theme has a light and a dark variant." title="Colour theme">
          <div className="rounded-cg-md border border-cg-control bg-cg-panel px-1">
            <QuietSelect
              aria-label="Theme"
              className="min-w-[13rem] px-2 py-1.5 text-ui text-cg-ink"
              options={options}
              searchable={options.length > 8}
              value={selected}
              onChange={setTheme}
            />
          </div>
        </SettingRow>
        <SettingRow
          below={
            <div aria-label="Colours of this theme" className="flex items-center gap-1.5" role="img">
              {SWATCHES.map((name) => (
                <span
                  key={name}
                  className="h-5 w-5 rounded-cg-sm border border-cg-line-strong"
                  style={{ background: `var(${name})` }}
                />
              ))}
              <span className="ml-1.5 text-small text-cg-muted-strong">{kind === "dark" ? "Dark" : "Light"} now</span>
            </div>
          }
          hint={imported ? "An imported theme has the one mode it was made in." : "System follows the light or dark setting of the computer."}
          title="Mode"
        >
          <div aria-label="Mode" className="flex items-center gap-1" role="group">
            {MODES.map((item) => (
              <Button
                key={item.id}
                aria-pressed={!imported && mode === item.id}
                disabled={Boolean(imported)}
                variant="quiet"
                onClick={() => setMode(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          hint={
            <>
              The <code className="font-mono">.json</code> of any VS Code colour theme. The interface, editor and terminal take
              its colours. Code is coloured by the editor's own grammars, so it follows the theme closely, not exactly.
            </>
          }
          title="VS Code theme"
          below={
            messages.length > 0 ? (
              <ul aria-live="polite" className="flex flex-col gap-0.5 text-small leading-5" role="status">
                {messages.map((item) => (
                  <li key={item.text} className={item.problem ? "text-cg-red" : "text-cg-muted-strong"}>
                    {item.text}
                  </li>
                ))}
              </ul>
            ) : null
          }
        >
          {imported ? (
            <Button variant="quiet" onClick={() => removeTheme(imported.id)}>
              Remove
            </Button>
          ) : null}
          <Button variant="quiet" onClick={() => picker.current?.click()}>
            Import…
          </Button>
          <input
            ref={picker}
            accept=".json,.jsonc,application/json"
            aria-label="VS Code theme files"
            className="sr-only"
            multiple
            tabIndex={-1}
            type="file"
            onChange={(event) => void onFiles(event.target.files)}
          />
        </SettingRow>
      </section>

      <section aria-label="Fonts" className="flex flex-col">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-small font-semibold text-cg-muted-strong">Fonts</h3>
          <Button variant="quiet" onClick={resetFonts}>
            Reset
          </Button>
        </div>
        <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr)_12rem_7rem] gap-x-4 border-b border-cg-line pb-2 text-small text-cg-muted-strong @lg:grid">
          <span>Area</span>
          <span>Typeface</span>
          <span>Size</span>
        </div>
        {AREAS.map((area) => (
          <FontRow key={area.id} area={area.id} hint={area.hint} label={area.label} />
        ))}
      </section>
    </div>
  );
}
