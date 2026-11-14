import { useCallback, useMemo, useState } from "react";
import { DiagramSource, MermaidSvg, isDrawn } from "./MermaidFallback";
import { AsciiDiagram } from "./diagram/AsciiDiagram";
import { sharedRenderer } from "./diagram/gpu";
import { useQuiet, useSettled } from "./diagram/hooks";
import { useDiagramPrefs } from "./diagram/prefs";
import { cachedScene } from "./diagram/scene";

/** A pause in the source this long means the writer is done, so the drawing is worth the work. */
const SETTLE_MS = 350;

/**
 * A fenced `mermaid` block. A flowchart is drawn as animated text on the graphics card, which
 * costs a fraction of what the Mermaid library does and nothing while it is at rest. What that
 * cannot show faithfully (other kinds of diagram, subgraphs, a very large chart, a label in a
 * wide script) and a machine without WebGL2 get the Mermaid library's SVG instead, loaded only
 * then. While the text may still be arriving, a diagram that is not (yet) a flowchart shows its
 * code and does not start the library: a reply that is half written is often not a diagram
 * the text drawing refuses, only one that is not finished.
 */
export function Mermaid({ source }: { source: string }) {
  const prefs = useDiagramPrefs();
  // While the text is still arriving the drawing stays as it was; the first one is at once.
  const settled = useSettled(source, SETTLE_MS);
  const quiet = useQuiet(source, SETTLE_MS);
  const built = useMemo(() => cachedScene(settled, prefs.style), [settled, prefs.style]);
  const [gpu] = useState(() => sharedRenderer() !== null);
  const [failed, setFailed] = useState(false);
  const unavailable = useCallback(() => setFailed(true), []);

  if (built.ok && gpu && !failed) {
    return <AsciiDiagram scene={built.scene} source={settled} onUnavailable={unavailable} />;
  }
  if (quiet || isDrawn(source)) {
    return <MermaidSvg source={source} />;
  }
  return <DiagramSource source={source} />;
}
