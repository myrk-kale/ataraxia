import { Code2, Image as ImageIcon, Maximize2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Dialog } from "../ui/Overlay";
import { CopyButton } from "./CopyButton";
import { useQuiet } from "./diagram/hooks";
import { DiagramSource, useThemeSignal } from "./MermaidFallback";
import { prepareSvg, svgDataUrl, svgTheme, type PreparedSvg } from "./svg/prepare";

/** A pause in the source this long means the writer is done: an unfinished drawing is not an error. */
const SETTLE_MS = 350;

/** Drawings already prepared, by theme and text, so one that scrolls out of the transcript and back costs nothing. */
const LIMIT = 40;
const prepared = new Map<string, PreparedSvg>();

function prepare(source: string): PreparedSvg {
  const root = getComputedStyle(document.documentElement);
  const theme = svgTheme((name) => root.getPropertyValue(name));
  const key = `${JSON.stringify(theme)}|${source}`;
  const known = prepared.get(key);
  if (known) {
    prepared.delete(key);
    prepared.set(key, known);
    return known;
  }
  const made = prepareSvg(source, theme);
  prepared.set(key, made);
  if (prepared.size > LIMIT) {
    const oldest = prepared.keys().next().value;
    if (oldest !== undefined) {
      prepared.delete(oldest);
    }
  }
  return made;
}

const TOOL =
  "flex items-center gap-1 rounded-cg-sm border border-cg-line-strong bg-cg-panel px-2 py-1 text-small text-cg-muted-strong hover:text-cg-ink focus-visible:outline-2 focus-visible:outline-cg-accent";

/**
 * A fenced `svg` block, drawn as the picture it describes. It is shown through an `<img>`, which
 * is an image document: nothing in it can run, and nothing in it is fetched. While the text is
 * still arriving the reader sees a placeholder, not half a drawing; if it never becomes a valid
 * SVG they see its code and why. The code can always be shown or copied, and the drawing opened
 * larger.
 */
export function SvgBlock({ source }: { source: string }) {
  const theme = useThemeSignal();
  const quiet = useQuiet(source, SETTLE_MS);
  const result = useMemo(() => prepare(source), [source, theme]);
  const [code, setCode] = useState(false);
  const [large, setLarge] = useState(false);

  if (!result.ok) {
    if (!quiet) {
      return (
        <figure aria-label="Drawing in progress" className="my-2" role="status">
          <div className="grid h-40 place-items-center rounded-cg-md border border-dashed border-cg-line-strong text-small text-cg-muted-strong">
            Drawing…
          </div>
        </figure>
      );
    }
    return <DiagramSource note={`Could not draw this SVG: ${result.reason}.`} source={source} />;
  }
  if (code) {
    return (
      <figure aria-label="SVG source" className="group/copy relative my-2">
        <div className="absolute top-1.5 right-1.5 z-10 flex gap-1.5">
          <button className={TOOL} type="button" onClick={() => setCode(false)}>
            <ImageIcon aria-hidden="true" size={12} />
            Image
          </button>
          <CopyButton inline read={() => ({ text: result.source })} what="SVG" />
        </div>
        <pre className="overflow-x-auto rounded-cg-md bg-cg-tint p-4.5 pr-36 font-mono text-small leading-[1.95]">
          <code>{result.source}</code>
        </pre>
      </figure>
    );
  }
  const label = result.title || "Diagram";
  const url = svgDataUrl(result.markup);
  return (
    <figure aria-label={label} className="group/copy relative my-2">
      <div className="absolute top-1.5 right-1.5 z-10 flex gap-1.5 opacity-0 group-focus-within/copy:opacity-100 group-hover/copy:opacity-100">
        <button className={TOOL} type="button" onClick={() => setLarge(true)}>
          <Maximize2 aria-hidden="true" size={12} />
          Expand
        </button>
        <button className={TOOL} type="button" onClick={() => setCode(true)}>
          <Code2 aria-hidden="true" size={12} />
          Code
        </button>
        <CopyButton inline read={() => ({ text: result.source })} what="SVG" />
      </div>
      <div className="flex justify-center overflow-hidden rounded-cg-md border border-cg-line bg-cg-panel p-3">
        <img
          alt={result.description ? `${label}. ${result.description}` : label}
          className="h-auto max-w-full"
          height={result.height}
          src={url}
          style={{ aspectRatio: `${result.width} / ${result.height}` }}
          width={result.width}
        />
      </div>
      <Dialog className="m-auto flex h-[90vh] w-[94vw] max-w-none items-center justify-center p-4" isOpen={large} label={label} size="full" onClose={() => setLarge(false)}>
        <img alt={result.description ? `${label}. ${result.description}` : label} className="h-full w-full object-contain" src={url} />
      </Dialog>
    </figure>
  );
}
