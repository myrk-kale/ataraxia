import { useEffect, useMemo, useState } from "react";
import { sessionPaths, type MentionPath } from "../lib/agent";
import type { FileIndex } from "./fileRefs";

/**
 * The files of a chat in the names the app uses, from what `@` offers: a file of the chat's own
 * repository is bare, one of another repository is listed by absolute path with the repository's
 * name, which is turned into `<repository>/<path>`.
 */
export function fileIndexFrom(paths: readonly MentionPath[], ownRoot: string | null): FileIndex {
  const roots = new Map<string, string>();
  for (const item of paths) {
    if (item.repository && item.dir) {
      const known = roots.get(item.repository);
      if (known === undefined || item.path.length < known.length) {
        roots.set(item.repository, item.path);
      }
    }
  }
  const files = new Set<string>();
  for (const item of paths) {
    if (item.dir) {
      continue;
    }
    if (!item.repository) {
      files.add(item.path);
      continue;
    }
    const root = roots.get(item.repository);
    if (root && item.path.startsWith(root)) {
      files.add(`${item.repository}/${item.path.slice(root.length)}`);
    }
  }
  return {
    files,
    ownRoot,
    others: [...roots].map(([name, root]) => ({ name, root: root.replace(/\/$/, "") })),
  };
}

/**
 * The files the chat can name, read when it opens and again each time the agent stops working
 * (`settled` changes), since a turn is when files appear. Without files nothing is linked.
 */
export function useFileIndex(sessionId: string, ownRoot: string | null, settled: unknown, enabled: boolean): FileIndex | null {
  const [paths, setPaths] = useState<MentionPath[] | null>(null);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let live = true;
    sessionPaths(sessionId)
      .then((found) => live && setPaths(found))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sessionId, settled, enabled]);
  return useMemo(() => (paths ? fileIndexFrom(paths, ownRoot) : null), [paths, ownRoot]);
}
