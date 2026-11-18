/** A file named in the chat, with the lines it points at. */
export type FileCite = { path: string; line: number | null; endLine: number | null };

/** Where the files of a chat live, to turn what was written into a file the app can open. */
export type FileIndex = {
  /** Files by the name the app uses: bare for the chat's own repository, `<repository>/<path>` for the others. */
  files: ReadonlySet<string>;
  /** The folder of the chat's own repository, as an absolute path. */
  ownRoot: string | null;
  /** The other repositories of the workspace. */
  others: readonly { name: string; root: string }[];
};

const LINE_SUFFIX = /(?::(\d+)(?:[-–](\d+))?(?::\d+)?|#L(\d+)(?:C\d+)?(?:[-–]L?(\d+)(?:C\d+)?)?)$/;

function toLine(value: string | undefined): number | null {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Splits `path`, `path:12`, `path:12-20`, `path:12:5`, `path#L12`, `path#L12-L20` and
 * `path#L12C3` into the path and its lines. A range that runs backwards is put right.
 */
export function parseCite(text: string): FileCite {
  const match = LINE_SUFFIX.exec(text);
  if (!match) {
    return { path: text, line: null, endLine: null };
  }
  const line = toLine(match[1] ?? match[3]);
  let endLine = toLine(match[2] ?? match[4]);
  if (line !== null && endLine !== null && endLine < line) {
    endLine = line;
  }
  return { path: text.slice(0, match.index), line, endLine };
}

function normalize(path: string): string {
  let out = path.replace(/\\/g, "/");
  while (out.startsWith("./")) {
    out = out.slice(2);
  }
  return out;
}

function stripFileScheme(href: string): string {
  if (/^file:\/\//i.test(href)) {
    const raw = href.replace(/^file:\/\/(?:localhost)?/i, "");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return href;
}

/**
 * The file a written path stands for, in the name the app uses, or `null` when it is no file this
 * chat has. Absolute paths inside a repository, paths relative to the chat's own repository,
 * `<repository>/<path>` and a bare file name that only one file has are all understood.
 */
export function resolveFile(index: FileIndex, written: string): string | null {
  const text = normalize(stripFileScheme(written.trim()));
  if (!text) {
    return null;
  }
  const { files, ownRoot, others } = index;
  if (text.startsWith("/") || /^[A-Za-z]:\//.test(text)) {
    const roots = [
      ...(ownRoot ? [{ name: null as string | null, root: normalize(ownRoot).replace(/\/$/, "") }] : []),
      ...others.map((item) => ({ name: item.name as string | null, root: normalize(item.root).replace(/\/$/, "") })),
    ].sort((a, b) => b.root.length - a.root.length);
    for (const { name, root } of roots) {
      if (text.startsWith(`${root}/`)) {
        const relative = text.slice(root.length + 1);
        const known = name === null ? relative : `${name}/${relative}`;
        return files.has(known) ? known : null;
      }
    }
    return null;
  }
  if (files.has(text)) {
    return text;
  }
  if (!text.includes("/")) {
    // A bare name stands for a file only when exactly one has it.
    let found: string | null = null;
    for (const file of files) {
      if (file === text || file.endsWith(`/${text}`)) {
        if (found !== null) {
          return null;
        }
        found = file;
      }
    }
    return found;
  }
  // `src/a.ts` named from a subfolder, or a path with its repository's folder left off.
  let found: string | null = null;
  for (const file of files) {
    if (file.endsWith(`/${text}`)) {
      if (found !== null) {
        return null;
      }
      found = file;
    }
  }
  return found;
}

/** What a cited text, as written in a message, opens: the file and the lines, or `null`. */
export function resolveCite(index: FileIndex, written: string): FileCite | null {
  const cite = parseCite(written.trim());
  const path = resolveFile(index, cite.path);
  return path ? { ...cite, path } : null;
}

const PATH = String.raw`(?:(?:\.{0,2}\/)?(?:[\w.@+~-]+\/)+[\w.@+~-]+|[\w.@+~-]+\.[A-Za-z0-9]{1,10})`;
const SUFFIX = String.raw`(?::\d+(?:[-–]\d+)?(?::\d+)?|#L\d+(?:C\d+)?(?:[-–]L?\d+(?:C\d+)?)?)?`;

/** A file name in running text (`src/a.ts`, `a.ts:12-20`, `/abs/a.ts#L3`) and where it sits. */
export function findCites(text: string): { start: number; end: number; text: string }[] {
  const pattern = new RegExp(`${PATH}${SUFFIX}`, "g");
  const found: { start: number; end: number; text: string }[] = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index;
    let end = start + match[0].length;
    const before = start > 0 ? text[start - 1] : "";
    const after = end < text.length ? text[end] : "";
    // Part of a longer word, a URL or an address (`a@b.c`, `http://x/y.ts`) is not a path of ours.
    if (/[\w@:/.-]/.test(before) || /[\w/@]/.test(after) || (match[0].includes("://"))) {
      continue;
    }
    // A sentence's full stop is not the end of a name.
    while (end > start && /[.,;:!?)\]]/.test(text[end - 1] ?? "")) {
      end -= 1;
    }
    if (end > start) {
      found.push({ start, end, text: text.slice(start, end) });
    }
  }
  return found;
}
