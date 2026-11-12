import { AXOLOTL_ART } from "./axolotlArt";

/** The braille axolotl, floating gently. Decorative: it is hidden from assistive technology. */
export function Axolotl() {
  return (
    <div aria-hidden="true" className="flex justify-center">
      <pre className="cg-axolotl m-0 font-mono text-[clamp(6px,0.62vw,9px)] leading-[0.94] whitespace-pre text-cg-ink select-none">
        {AXOLOTL_ART}
      </pre>
    </div>
  );
}
