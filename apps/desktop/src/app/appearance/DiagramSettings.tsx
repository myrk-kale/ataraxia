import { EFFECT_OPTIONS } from "../../chat/diagram/EffectSelect";
import { STYLE_LABELS, STYLE_NAMES, type StyleName } from "../../chat/diagram/glyphs";
import { setDiagramPrefs, useDiagramPrefs, type DiagramPrefs } from "../../chat/diagram/prefs";
import { QuietSelect, type SelectOption } from "../../ui/QuietSelect";
import { Toggle } from "../../ui/Overlay";
import { SettingRow } from "./AppearanceSettings";

const STYLE_OPTIONS: SelectOption[] = STYLE_NAMES.map((style) => ({ value: style, label: STYLE_LABELS[style] }));

/**
 * How the flowcharts in a reply are drawn: as text on the graphics card, with an animation that
 * plays once as one comes into view. Anything that is not a flowchart is drawn as an SVG and is
 * not affected.
 */
export function DiagramSettings() {
  const prefs = useDiagramPrefs();
  return (
    <section aria-label="Diagrams" className="flex flex-col">
      <h3 className="mb-3 text-small font-semibold text-cg-muted-strong">Diagrams</h3>
      <SettingRow
        hint="How a flowchart in a reply is animated. Click a diagram to pause it and click again to go on; each diagram also has its own choice of animation. Ignored when the system asks for reduced motion."
        title="Animation"
      >
        <div className="rounded-cg-md border border-cg-control bg-cg-panel px-1">
          <QuietSelect
            aria-label="Diagram animation"
            className="min-w-[11rem] px-2 py-1.5 text-ui text-cg-ink"
            options={EFFECT_OPTIONS}
            value={prefs.effect}
            onChange={(effect) => setDiagramPrefs({ effect: effect as DiagramPrefs["effect"] })}
          />
        </div>
      </SettingRow>
      <SettingRow
        hint="Repeat the animation for as long as the diagram is on screen. It stops when the diagram scrolls away or is paused. Off plays it once as the diagram comes into view and then leaves it still, which saves power."
        title="Repeat"
      >
        <Toggle
          hideLabel
          isDisabled={prefs.effect === "none"}
          isSelected={prefs.loop && prefs.effect !== "none"}
          label="Repeat the animation while visible"
          onChange={(loop) => setDiagramPrefs({ loop })}
        />
      </SettingRow>
      <SettingRow hint="The pieces the boxes and lines are drawn with." title="Lines">
        <div className="rounded-cg-md border border-cg-control bg-cg-panel px-1">
          <QuietSelect
            aria-label="Diagram lines"
            className="min-w-[11rem] px-2 py-1.5 text-ui text-cg-ink"
            options={STYLE_OPTIONS}
            value={prefs.style}
            onChange={(style) => setDiagramPrefs({ style: style as StyleName })}
          />
        </div>
      </SettingRow>
    </section>
  );
}
