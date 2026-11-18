/** The colours a drawing may use by name, taken from the app so it follows the theme the reader chose. */
const TOKENS = {
  panel: ["--cg-panel", "#ffffff"],
  tint: ["--cg-tint", "#f4f4f1"],
  ink: ["--cg-ink", "#232522"],
  muted: ["--cg-muted-strong", "#50534e"],
  line: ["--cg-line-strong", "#dbdad5"],
  accent: ["--cg-accent", "#665698"],
  accentBg: ["--cg-accent-bg", "#f0edf8"],
  green: ["--cg-green", "#2c6b55"],
  red: ["--cg-red", "#a4444c"],
  amber: ["--cg-amber", "#b57712"],
} as const;

export type SvgTheme = Record<keyof typeof TOKENS, string>;

/** Hex and rgb()/hsl() only: anything else could carry markup into the stylesheet we write. */
function usable(value: string): boolean {
  return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\))$/i.test(value);
}

/** The theme, read through `read` (a CSS custom property reader). */
export function svgTheme(read: (name: string) => string): SvgTheme {
  const out = {} as SvgTheme;
  for (const key of Object.keys(TOKENS) as (keyof typeof TOKENS)[]) {
    const [name, fallback] = TOKENS[key];
    const value = read(name).trim();
    out[key] = usable(value) ? value : fallback;
  }
  return out;
}

/** What a drawing can lean on without knowing the theme; `svg.md` of the guide teaches the same names. */
export function themeStyle(theme: SvgTheme): string {
  return [
    `svg{--panel:${theme.panel};--tint:${theme.tint};--ink:${theme.ink};--muted:${theme.muted};--line:${theme.line};`,
    `--accent:${theme.accent};--accent-bg:${theme.accentBg};--green:${theme.green};--red:${theme.red};--amber:${theme.amber};`,
    `fill:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}`,
    `.bg{fill:var(--panel)}`,
    `.node{fill:var(--tint);stroke:var(--line);stroke-width:1.5}`,
    `.node-accent{fill:var(--accent-bg);stroke:var(--accent);stroke-width:1.5}`,
    `.edge{fill:none;stroke:var(--muted);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}`,
    `.edge-accent{fill:none;stroke:var(--accent);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}`,
    `.arrow{fill:var(--muted)}`,
    `.title{font-size:22px;font-weight:650}`,
    `.label{font-size:15px;font-weight:550}`,
    `.small{font-size:13px;fill:var(--muted)}`,
    `.muted{fill:var(--muted)}`,
    `.accent{fill:var(--accent)}`,
    `.good{fill:var(--green)}`,
    `.bad{fill:var(--red)}`,
    `.warn{fill:var(--amber)}`,
  ].join("");
}

/** A drawing longer than this is not a diagram; it would also cost more than it is worth to show. */
export const MAX_SVG_CHARS = 300_000;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Elements that run code, load things, embed other documents or move: none has a place in a diagram. */
const DROPPED = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "audio",
  "video",
  "canvas",
  "image",
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
]);

/** A `url(...)` that points anywhere but inside the drawing is replaced; nothing is fetched for a diagram. */
function withoutOutsideUrls(value: string): string {
  return value.replace(/@import[^;]*;?/gi, "").replace(/url\(\s*(?!['"]?#)[^)]*\)/gi, "none");
}

function clean(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on")) {
      element.removeAttribute(attribute.name);
    } else if ((name === "href" || name === "xlink:href") && !attribute.value.trim().startsWith("#")) {
      element.removeAttribute(attribute.name);
    } else if (attribute.value.includes("url(") || /@import/i.test(attribute.value)) {
      element.setAttribute(attribute.name, withoutOutsideUrls(attribute.value));
    }
  }
  if (element.localName.toLowerCase() === "style") {
    element.textContent = withoutOutsideUrls(element.textContent ?? "");
  }
  for (const child of Array.from(element.children)) {
    if (DROPPED.has(child.localName.toLowerCase())) {
      child.remove();
    } else {
      clean(child);
    }
  }
}

function number(text: string | null): number | null {
  const value = text === null ? NaN : parseFloat(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type PreparedSvg =
  | {
      ok: true;
      /** The drawing with the theme's stylesheet in it: what the reader sees. */
      markup: string;
      /** The drawing as written, made safe: what is copied. */
      source: string;
      width: number;
      height: number;
      title: string;
      description: string;
    }
  | { ok: false; reason: string };

/** Puts back what writers often leave out, so a drawing that is only sloppy still parses. */
function lenient(source: string): string {
  let text = source.trim();
  text = text.replace(/^<\?xml[^>]*\?>\s*/i, "");
  const opening = /<svg\b[^>]*>/i.exec(text);
  if (opening) {
    let tag = opening[0];
    if (!/\sxmlns\s*=/.test(tag)) {
      tag = tag.replace(/<svg\b/i, `<svg xmlns="${SVG_NS}"`);
    }
    if (/xlink:/.test(text) && !/xmlns:xlink/.test(tag)) {
      tag = tag.replace(/<svg\b/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    }
    text = text.replace(opening[0], tag);
  }
  return text;
}

/**
 * Checks a drawing an agent wrote and makes it safe to show: it must be one well-formed `<svg>`,
 * has everything that could run, load or leave the page taken out, gets a size from its `viewBox`,
 * and gets the theme's stylesheet ahead of its own. It is shown as an image, which already cannot
 * run anything; this is for what is copied out of it and opened elsewhere.
 */
export function prepareSvg(source: string, theme: SvgTheme): PreparedSvg {
  if (source.length > MAX_SVG_CHARS) {
    return { ok: false, reason: "the drawing is too large" };
  }
  if (/<!(DOCTYPE|ENTITY)/i.test(source)) {
    return { ok: false, reason: "it declares entities, which a drawing does not need" };
  }
  const parsed = new DOMParser().parseFromString(lenient(source), "image/svg+xml");
  const root = parsed.documentElement;
  if (parsed.getElementsByTagName("parsererror").length > 0 || root.localName !== "svg" || root.namespaceURI !== SVG_NS) {
    return { ok: false, reason: "it is not a well-formed SVG" };
  }
  clean(root);

  let box = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  let width: number;
  let height: number;
  if (box && box.length === 4 && box.every(Number.isFinite) && (box[2] ?? 0) > 0 && (box[3] ?? 0) > 0) {
    width = box[2] as number;
    height = box[3] as number;
  } else {
    const w = number(root.getAttribute("width"));
    const h = number(root.getAttribute("height"));
    if (w === null || h === null) {
      return { ok: false, reason: "it has no viewBox, so it has no size" };
    }
    width = w;
    height = h;
    box = [0, 0, w, h];
    root.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));

  const text = (name: string) =>
    Array.from(root.children).find((child) => child.localName === name)?.textContent?.trim() ?? "";
  const title = text("title");
  const description = text("desc");
  const serializer = new XMLSerializer();
  const safe = serializer.serializeToString(root);

  const style = parsed.createElementNS(SVG_NS, "style");
  style.textContent = themeStyle(theme);
  root.insertBefore(style, root.firstChild);
  return { ok: true, markup: serializer.serializeToString(root), source: safe, width, height, title, description };
}

/** An `<img>` source for a drawing: an image document, so nothing in it runs or loads. */
export function svgDataUrl(markup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}
