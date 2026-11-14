import { useEffect, useRef, useState } from "react";
import { CopyButton } from "./CopyButton";
import { mermaidTheme } from "./mermaidTheme";

/** A pause in the source this long means the writer is done, so the drawing is worth the work. */
const SETTLE_MS = 350;

let counter = 0;

/**
 * Drawings already made, by what they were drawn from and in which colours. A diagram that
 * scrolls out of the transcript and back is shown from here, at the height it had, instead of
 * being drawn again; the cache is small because an SVG is text and there are few of them.
 */
const DRAWN_LIMIT = 40;
const drawn = new Map<string, string>();

function remember(key: string, svg: string) {
  drawn.delete(key);
  drawn.set(key, svg);
  if (drawn.size > DRAWN_LIMIT) {
    const oldest = drawn.keys().next().value;
    if (oldest !== undefined) {
      drawn.delete(oldest);
    }
  }
}

function currentTheme() {
  const root = getComputedStyle(document.documentElement);
  return mermaidTheme((name) => root.getPropertyValue(name), getComputedStyle(document.body).fontFamily);
}

function drawingKey(source: string, theme: ReturnType<typeof currentTheme>): string {
  return `${JSON.stringify(theme.variables)}|${theme.dark}|${source}`;
}

/** Whether the library has already drawn this text, so showing it costs nothing. */
export function isDrawn(source: string): boolean {
  return cachedDrawing(source) !== null;
}

/** The code of a diagram, while it may still be arriving or before it is drawn. */
export function DiagramSource({ source, note }: { source: string; note?: string }) {
  return (
    <figure aria-label="Mermaid diagram" className="group/copy relative my-2">
      <CopyButton read={() => ({ text: source })} what="diagram source" />
      <pre className="overflow-x-auto rounded-cg-md bg-cg-tint p-4.5 font-mono text-small leading-[1.95]">
        <code>{source}</code>
      </pre>
      {note ? (
        <figcaption className="mt-1.5 text-small text-cg-muted-strong" role="note">
          {note}
        </figcaption>
      ) : null}
    </figure>
  );
}

function cachedDrawing(source: string): string | null {
  const key = drawingKey(source, currentTheme());
  const svg = drawn.get(key);
  if (svg !== undefined) {
    // Looked at again: keep it.
    remember(key, svg);
  }
  return svg ?? null;
}

/** Bumps when the app's theme changes, so diagrams are drawn again in its colours. */
function useThemeSignal(): number {
  const [signal, setSignal] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setSignal((value) => value + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return signal;
}

async function draw(source: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  const theme = currentTheme();
  const key = drawingKey(source, theme);
  mermaid.initialize({
    startOnLoad: false,
    // The text comes from an agent or a pasted document: labels are sanitised and scripts never run.
    securityLevel: "strict",
    theme: "base",
    darkMode: theme.dark,
    themeVariables: theme.variables,
  });
  const id = `ataraxia-mermaid-${(counter += 1)}`;
  try {
    const svg = (await mermaid.render(id, source)).svg;
    remember(key, svg);
    return svg;
  } finally {
    // A failed drawing leaves its error graphic in the page.
    document.getElementById(`d${id}`)?.remove();
  }
}

function oneLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "unknown error";
}

/**
 * A fenced `mermaid` block drawn as an SVG by the Mermaid library, for what the text drawing
 * cannot show (other kinds of diagram, subgraphs, very large flowcharts) and for a machine
 * without WebGL2. The library loads only the first time one is needed. While the text is still
 * arriving, or when it is not a diagram, the reader sees the source.
 */
export function MermaidSvg({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(() => cachedDrawing(source));
  const [failure, setFailure] = useState<string | null>(null);
  const theme = useThemeSignal();
  const latest = useRef(source);
  latest.current = source;

  useEffect(() => {
    const known = cachedDrawing(source);
    if (known !== null) {
      setSvg(known);
      setFailure(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      draw(source).then(
        (drawn) => {
          if (!cancelled) {
            setSvg(drawn);
            setFailure(null);
          }
        },
        (error: unknown) => {
          if (!cancelled) {
            setFailure(oneLine(error));
          }
        },
      );
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, theme]);

  if (svg === null || failure !== null) {
    return <DiagramSource note={failure !== null ? `Could not draw this diagram: ${failure}` : undefined} source={source} />;
  }
  return (
    <figure aria-label="Mermaid diagram" className="group/copy relative my-2">
      <CopyButton read={() => ({ text: latest.current })} what="diagram source" />
      <div
        className="flex justify-center overflow-x-auto rounded-cg-md border border-cg-line bg-cg-panel p-4 [&_svg]:h-auto [&_svg]:max-w-full"
        // The library sanitised it (strict mode); it is an SVG document, not markup of ours.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </figure>
  );
}
