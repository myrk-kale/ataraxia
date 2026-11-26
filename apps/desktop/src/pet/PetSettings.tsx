import { ImagePlus, RotateCcw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { SettingRow } from "../app/appearance/AppearanceSettings";
import { Button } from "../ui/Button";
import type { PetState } from "./activity";
import { ACCESSORIES, COLORS, NAME_MAX, SCALE, SPECIES, sizeOf, type PetMode } from "./config";
import { toPetImage } from "./image";
import { Sprite } from "./Sprite";
import { resetPet, updatePet, usePet } from "./store";

const STATES: { id: PetState; label: string }[] = [
  { id: "idle", label: "Resting" },
  { id: "running", label: "Working" },
  { id: "needs-input", label: "Needs you" },
  { id: "ready", label: "Done" },
  { id: "blocked", label: "Error" },
];

const MODES: { id: PetMode; label: string; hint: string }[] = [
  { id: "pet", label: "Pet", hint: "The character, floating" },
  { id: "mini", label: "Mini", hint: "Only the status" },
  { id: "off", label: "Off", hint: "Nothing on screen" },
];

function Choice({ pressed, label, onClick, children }: { pressed: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={`grid place-items-center rounded-cg-md border p-1.5 ${pressed ? "border-cg-ink bg-cg-tint" : "border-cg-line hover:bg-cg-tint"}`}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * The companion's settings: whether it is there, who it is (a species, a colour, an accessory, a
 * name, or a picture of your own), how large, and where it starts. The preview moves the way it
 * does for each state, so you can see what it will do before an agent makes it do it.
 */
export function PetSettings() {
  const pet = usePet();
  const [preview, setPreview] = useState<PetState>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function pick(files: FileList | null) {
    const chosen = files?.[0];
    if (!chosen) return;
    setProblem(null);
    try {
      updatePet({ image: await toPetImage(chosen) });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
    if (file.current) file.current.value = "";
  }

  return (
    <div>
      <p className="mb-5 text-small leading-5 text-cg-muted-strong">
        A small companion that floats over the app and shows what your agents are doing: working, waiting for you, done, or stopped with an error. Drag it anywhere. Type <code>/pet</code> in a chat to show or hide it.
      </p>
      <div className="mb-5 flex items-center gap-5 rounded-cg-lg border border-cg-line bg-cg-tint p-4">
        <div className="grid h-[150px] w-[150px] flex-none place-items-center">
          <Sprite accessory={pet.accessory} color={pet.color} image={pet.image} name={pet.name} size={Math.min(140, sizeOf(pet))} species={pet.species} state={preview} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="text-small font-semibold text-cg-muted-strong">Preview</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Preview a state">
            {STATES.map((state) => (
              <Button key={state.id} aria-pressed={preview === state.id} size="sm" variant="quiet" onClick={() => setPreview(state.id)}>
                {state.label}
              </Button>
            ))}
          </div>
          <p className="text-small text-cg-muted">With reduced motion on in your system it stays still.</p>
        </div>
      </div>

      <SettingRow hint="Mini keeps only the status, without the character." title="Show">
        <div className="flex gap-1.5" role="radiogroup" aria-label="Show the companion">
          {MODES.map((mode) => (
            <Button key={mode.id} aria-checked={pet.mode === mode.id} role="radio" size="sm" title={mode.hint} variant={pet.mode === mode.id ? "secondary" : "quiet"} onClick={() => updatePet({ mode: mode.id })}>
              {mode.label}
            </Button>
          ))}
        </div>
      </SettingRow>

      <SettingRow hint="It shows in the speech bubble and for screen readers." title="Name">
        <input
          aria-label="Name"
          className="h-8 w-44 rounded-cg-md border border-cg-control bg-cg-panel px-2.5 text-ui text-cg-ink"
          maxLength={NAME_MAX}
          value={pet.name}
          onBlur={(event) => updatePet({ name: event.target.value.trim() || "Ata" })}
          onChange={(event) => updatePet({ name: event.target.value })}
        />
      </SettingRow>

      <SettingRow hint="Drawn in code, so any colour and accessory goes on any of them." title="Who">
        <div className="flex flex-wrap justify-end gap-1.5" role="group" aria-label="Species">
          {SPECIES.map((species) => (
            <Choice key={species.id} label={species.label} pressed={!pet.image && pet.species === species.id} onClick={() => updatePet({ species: species.id, image: null })}>
              <Sprite accessory="none" color={pet.color} image={null} name={species.label} size={44} species={species.id} state="running" />
            </Choice>
          ))}
        </div>
      </SettingRow>

      <SettingRow hint="Used by the species. Your own picture keeps its colours." title="Colour">
        <div className="flex flex-wrap items-center justify-end gap-1.5" role="group" aria-label="Colour">
          {COLORS.map((color) => (
            <button
              key={color}
              aria-label={`Colour ${color}`}
              aria-pressed={pet.color === color}
              className={`h-6 w-6 rounded-full border ${pet.color === color ? "ring-2 ring-cg-ink ring-offset-2 ring-offset-cg-panel" : "border-cg-line-strong"}`}
              style={{ background: color }}
              type="button"
              onClick={() => updatePet({ color })}
            />
          ))}
          <input
            aria-label="Another colour"
            className="h-6 w-8 cursor-pointer rounded-cg-sm border border-cg-line-strong bg-transparent p-0"
            type="color"
            value={pet.color}
            onChange={(event) => updatePet({ color: event.target.value.toLowerCase() })}
          />
        </div>
      </SettingRow>

      <SettingRow title="Accessory">
        <div className="flex flex-wrap justify-end gap-1.5" role="radiogroup" aria-label="Accessory">
          {ACCESSORIES.map((accessory) => (
            <Button key={accessory.id} aria-checked={pet.accessory === accessory.id} disabled={pet.image !== null} role="radio" size="sm" variant={pet.accessory === accessory.id ? "secondary" : "quiet"} onClick={() => updatePet({ accessory: accessory.id })}>
              {accessory.label}
            </Button>
          ))}
        </div>
      </SettingRow>

      <SettingRow hint="A PNG, WebP, JPEG or GIF, up to 4 MB. It is made small and kept on this computer; an animated one becomes still." title="Your own picture" below={problem ? <p className="text-small text-cg-red" role="alert">{problem}</p> : null}>
        <input ref={file} accept="image/png,image/webp,image/jpeg,image/gif" aria-label="Choose a picture" className="sr-only" tabIndex={-1} type="file" onChange={(event) => void pick(event.target.files)} />
        <Button size="sm" variant="quiet" onClick={() => file.current?.click()}>
          <ImagePlus aria-hidden="true" size={13} />
          {pet.image ? "Change" : "Choose"}
        </Button>
        {pet.image ? (
          <Button size="sm" variant="quiet" onClick={() => updatePet({ image: null })}>
            <Trash2 aria-hidden="true" size={13} />
            Remove
          </Button>
        ) : null}
      </SettingRow>

      <SettingRow hint="Drag it on screen to move it; it stays where you leave it." title="Size">
        <input
          aria-label="Size"
          aria-valuetext={`${Math.round(pet.scale * 100)} percent`}
          className="h-1.5 w-40 cursor-pointer accent-[var(--cg-ink)]"
          max={SCALE.max}
          min={SCALE.min}
          step={SCALE.step}
          type="range"
          value={pet.scale}
          onChange={(event) => updatePet({ scale: Math.round(Number(event.target.value) * 10) / 10 })}
        />
        <span className="w-10 text-right text-small text-cg-muted-strong tabular-nums">{Math.round(pet.scale * 100)}%</span>
      </SettingRow>

      <SettingRow hint="Looks, size and corner go back to how it starts. Whether it is shown stays as it is." title="Start over">
        <Button size="sm" variant="quiet" onClick={() => resetPet()}>
          <RotateCcw aria-hidden="true" size={13} />
          Reset
        </Button>
      </SettingRow>
    </div>
  );
}
