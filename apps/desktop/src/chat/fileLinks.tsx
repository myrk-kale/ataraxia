import { createContext, useContext } from "react";
import { findCites, resolveCite, type FileCite, type FileIndex } from "./fileRefs";

/** What a message needs to make the files it names clickable. */
export type FileLinks = {
  index: FileIndex;
  /** Opens a file in the editor, at the lines it was cited with. `path` is the app's name for the file. */
  open: (cite: FileCite) => void;
};

export const FileLinksContext = createContext<FileLinks | null>(null);

export function useFileLinks(): FileLinks | null {
  return useContext(FileLinksContext);
}

/** The address a file link carries: it is read back by the link and never leaves the page. */
const FILE_HREF = "#ataraxia-file:";

export function fileHref(cite: FileCite): string {
  return `${FILE_HREF}${encodeURIComponent(JSON.stringify(cite))}`;
}

export function readFileHref(href: string | undefined): FileCite | null {
  if (!href?.startsWith(FILE_HREF)) {
    return null;
  }
  try {
    const cite = JSON.parse(decodeURIComponent(href.slice(FILE_HREF.length))) as FileCite;
    return typeof cite.path === "string" ? cite : null;
  } catch {
    return null;
  }
}

type Node = {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
};

function linkOf(cite: FileCite, children: Node[]): Node {
  return { type: "link", url: fileHref(cite), children };
}

/** Splits running text around the files it names. */
function linkText(node: Node, index: FileIndex): Node[] | null {
  const text = node.value ?? "";
  const parts: Node[] = [];
  let at = 0;
  for (const found of findCites(text)) {
    const cite = resolveCite(index, found.text);
    if (!cite) {
      continue;
    }
    if (found.start > at) {
      parts.push({ type: "text", value: text.slice(at, found.start) });
    }
    parts.push(linkOf(cite, [{ type: "text", value: found.text }]));
    at = found.end;
  }
  if (parts.length === 0) {
    return null;
  }
  if (at < text.length) {
    parts.push({ type: "text", value: text.slice(at) });
  }
  return parts;
}

function walk(node: Node, index: FileIndex) {
  const children = node.children;
  if (!children) {
    return;
  }
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.type === "text") {
      const parts = linkText(child, index);
      if (parts) {
        children.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
    } else if (child.type === "inlineCode") {
      // `src/a.ts:12` as code is the usual way to name a file: the whole of it is the name.
      const cite = resolveCite(index, child.value ?? "");
      if (cite) {
        children[i] = linkOf(cite, [child]);
      }
    } else if (child.type !== "link" && child.type !== "linkReference" && child.type !== "code") {
      walk(child, index);
    }
  }
}

/**
 * A remark plugin that turns the files a message names into links, wherever they stand: in plain
 * text, in `code` spans, in a table. What is already a link is left to its own handler, and fenced
 * code stays as it is.
 */
export function remarkFileLinks(index: FileIndex) {
  return () => (tree: Node) => walk(tree, index);
}
