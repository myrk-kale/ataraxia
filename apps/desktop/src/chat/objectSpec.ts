/** What a fenced `object` block says: a file on Ataraxia's local file server, and how to show it. */
export type ObjectSpec = {
  url: string;
  downloadUrl: string;
  title: string;
  type: string;
  height: number;
  /** Whether a browser can draw this type in an `<object>`; any other is offered for download only. */
  inline: boolean;
};

export type ObjectParse = { ok: true; spec: ObjectSpec } | { ok: false; reason: string };

export const OBJECT_HEIGHT = { min: 200, max: 900, fallback: 480 } as const;

const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

/** Types a browser draws by itself. HTML is sandboxed by the server: no scripts run in it. */
export function canShowInline(type: string): boolean {
  return (
    type === "application/pdf" ||
    type === "text/html" ||
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/")
  );
}

/**
 * Reads the JSON of an `object` block. The address must be one of the app's own file server
 * (loopback, `/f/<id>/<name>`): anything else a reply puts here is refused, so a block can never
 * make the chat load a page from the web.
 */
export function parseObjectBlock(source: string): ObjectParse {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { ok: false, reason: "the block is not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "the block must be a JSON object" };
  }
  const fields = raw as Record<string, unknown>;
  if (typeof fields.url !== "string") {
    return { ok: false, reason: "`url` is missing" };
  }
  let url: URL;
  try {
    url = new URL(fields.url);
  } catch {
    return { ok: false, reason: "`url` is not an address" };
  }
  const local =
    url.protocol === "http:" &&
    LOOPBACK.has(url.hostname) &&
    url.port !== "" &&
    url.username === "" &&
    url.password === "" &&
    /^\/f\/[0-9a-f]{64}\/[^/]+$/.test(url.pathname);
  if (!local) {
    return { ok: false, reason: "only files from Ataraxia's local file server can be shown" };
  }
  url.search = "";
  url.hash = "";
  const download = new URL(url.href);
  download.searchParams.set("download", "1");

  const last = url.pathname.split("/").pop() ?? "";
  let fallbackTitle = last;
  try {
    fallbackTitle = decodeURIComponent(last);
  } catch {
    // A name that does not decode is shown as it is.
  }
  const title = typeof fields.title === "string" && fields.title.trim() ? fields.title.trim().slice(0, 200) : fallbackTitle;
  const type =
    typeof fields.type === "string" && /^[a-z]+\/[a-z0-9.+-]+$/i.test(fields.type.trim())
      ? fields.type.trim().toLowerCase()
      : "application/octet-stream";
  const asked = typeof fields.height === "number" && Number.isFinite(fields.height) ? fields.height : OBJECT_HEIGHT.fallback;
  const height = Math.min(OBJECT_HEIGHT.max, Math.max(OBJECT_HEIGHT.min, Math.round(asked)));
  return { ok: true, spec: { url: url.href, downloadUrl: download.href, title, type, height, inline: canShowInline(type) } };
}
