import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, ExternalLink, FileWarning } from "lucide-react";
import { useMemo, useState } from "react";
import { DiagramSource } from "./MermaidFallback";
import { useQuiet } from "./diagram/hooks";
import { parseObjectBlock } from "./objectSpec";

/** A pause in the source this long means the writer is done: half a block is not an error. */
const SETTLE_MS = 350;

const TOOL =
  "flex items-center gap-1 rounded-cg-sm border border-cg-line-strong bg-cg-panel px-2 py-1 text-small text-cg-muted-strong hover:text-cg-ink focus-visible:outline-2 focus-visible:outline-cg-accent";

function open(url: string) {
  void openUrl(url).catch(() => undefined);
}

/**
 * A fenced `object` block: a file the agent put on Ataraxia's local file server, shown in an
 * `<object>` when a browser can draw its type, with buttons to open or download it. The file is
 * served only on this machine, and the address is checked to be the app's own before anything is
 * loaded. If the file can no longer be opened (the app was closed since the reply was written and
 * every offer ended with it) the reader is told so instead of seeing an empty box.
 */
export function ObjectBlock({ source }: { source: string }) {
  const quiet = useQuiet(source, SETTLE_MS);
  const parsed = useMemo(() => parseObjectBlock(source), [source]);
  const [failed, setFailed] = useState(false);

  if (!parsed.ok) {
    if (!quiet) {
      return (
        <figure aria-label="File in progress" className="my-2" role="status">
          <div className="grid h-24 place-items-center rounded-cg-md border border-dashed border-cg-line-strong text-small text-cg-muted-strong">
            File…
          </div>
        </figure>
      );
    }
    return <DiagramSource note={`Could not show this file: ${parsed.reason}.`} source={source} />;
  }
  const { spec } = parsed;
  return (
    <figure aria-label={spec.title} className="my-2">
      {spec.inline && !failed ? (
        <object
          aria-label={spec.title}
          className="block w-full rounded-cg-md border border-cg-line bg-cg-panel"
          data={spec.url}
          style={{ height: spec.height }}
          type={spec.type}
          onError={() => setFailed(true)}
        >
          <p className="p-3 text-small text-cg-muted-strong">This file cannot be shown here. Open it or download it below.</p>
        </object>
      ) : (
        <div className="flex items-center gap-2 rounded-cg-md border border-cg-line bg-cg-panel px-3 py-2.5 text-small text-cg-muted-strong">
          <FileWarning aria-hidden="true" className="flex-none" size={14} />
          {failed
            ? "This file is no longer available: files are offered only while Ataraxia is open."
            : "This kind of file is not shown in the chat. Open it or download it below."}
        </div>
      )}
      <figcaption className="mt-1.5 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-small text-cg-muted-strong" title={spec.title}>
          {spec.title}
        </span>
        <span className="flex flex-none gap-1.5">
          <button className={TOOL} type="button" onClick={() => open(spec.url)}>
            <ExternalLink aria-hidden="true" size={12} />
            Open
          </button>
          <button className={TOOL} type="button" onClick={() => open(spec.downloadUrl)}>
            <Download aria-hidden="true" size={12} />
            Download
          </button>
        </span>
      </figcaption>
    </figure>
  );
}
