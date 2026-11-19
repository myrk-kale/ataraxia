import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Server, Square, X } from "lucide-react";
import {
  agentListMcpProcesses,
  agentStopMcpProcess,
  type McpProcessInfo,
} from "../lib/agent";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Overlay";

type LoadState =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; items: McpProcessInfo[] };

type WorkspaceGroup = {
  id: string | null;
  name: string;
  items: McpProcessInfo[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function groupByWorkspace(items: readonly McpProcessInfo[]): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();
  for (const item of items) {
    const key = item.workspaceId ?? "missing-workspace";
    const group = groups.get(key) ?? {
      id: item.workspaceId,
      name: item.workspaceName ?? "Workspace unavailable",
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function rowKey(item: McpProcessInfo): string {
  return `${item.sessionId}:${item.serverName}:${item.pid ?? "no-pid"}`;
}

function statusLabel(item: McpProcessInfo): string {
  switch (item.status) {
    case "running":
      return "Running";
    case "notDetected":
      return "Not detected";
    case "remote":
      return "Remote";
    case "unidentified":
      return "PID unavailable";
  }
}

function statusTone(item: McpProcessInfo): string {
  switch (item.status) {
    case "running":
      return "text-cg-green";
    case "unidentified":
      return "text-cg-amber-text";
    case "notDetected":
    case "remote":
      return "text-cg-muted-strong";
  }
}

export function McpServersDialog({
  isOpen,
  onClose,
  onOpenSession,
}: {
  isOpen: boolean;
  onClose: () => void;
  onOpenSession: (sessionId: string) => Promise<void>;
}) {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "closed" });
  const [refreshKey, setRefreshKey] = useState(0);
  const [stopping, setStopping] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setLoadState({ kind: "closed" });
      setActionError(null);
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    setLoadState({ kind: "loading" });

    async function refresh() {
      try {
        const items = await agentListMcpProcesses();
        if (!cancelled) {
          setLoadState({ kind: "ready", items });
        }
      } catch (error) {
        if (!cancelled) {
          setLoadState({ kind: "failed", message: errorMessage(error) });
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(() => void refresh(), 2500);
        }
      }
    }

    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [isOpen, refreshKey]);

  async function stopProcess(item: McpProcessInfo) {
    if (stopping || item.status !== "running" || item.pid === null || item.processStartedAt === null) {
      return;
    }
    const key = rowKey(item);
    setStopping(key);
    setActionError(null);
    try {
      await agentStopMcpProcess(item);
      setRefreshKey((current) => current + 1);
    } catch (error) {
      setActionError(errorMessage(error));
      setRefreshKey((current) => current + 1);
    } finally {
      setStopping(null);
    }
  }

  async function openSession(sessionId: string) {
    setActionError(null);
    try {
      await onOpenSession(sessionId);
      onClose();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  const items = loadState.kind === "ready" ? loadState.items : [];
  const groups = groupByWorkspace(items);
  const activeCount = items.filter((item) => item.status === "running" && item.pid !== null).length;

  return (
    <Dialog isOpen={isOpen} label="MCP servers" placement="top" size="lg" wide onClose={onClose}>
      <div className="flex max-h-[72vh] flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-cg-line px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Server aria-hidden="true" className="text-cg-muted-strong" size={16} />
              <h2 className="text-heading font-semibold text-cg-ink">MCP servers</h2>
            </div>
            <p className="mt-1 text-small leading-5 text-cg-muted-strong">
              {loadState.kind === "ready"
                ? `${activeCount} local process${activeCount === 1 ? "" : "es"} identified across live chats.`
                : "Local processes are matched to their harness before they can be stopped."}
            </p>
          </div>
          <Button aria-label="Close MCP servers" variant="icon" onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </Button>
        </header>

        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {actionError ? (
            <p className="mb-3 rounded-cg-sm border border-cg-red px-3 py-2 text-small text-cg-red" role="alert">
              {actionError}
            </p>
          ) : null}

          {loadState.kind === "loading" ? (
            <div aria-live="polite" className="flex items-center gap-2 py-8 text-ui text-cg-muted-strong">
              <Loader2 aria-hidden="true" className="animate-spin" size={14} />
              <span>Looking for MCP processes…</span>
            </div>
          ) : null}

          {loadState.kind === "failed" ? (
            <div className="py-6">
              <p className="text-ui text-cg-red" role="alert">
                Could not list MCP processes: {loadState.message}
              </p>
              <Button className="mt-3" size="sm" variant="secondary" onClick={() => setRefreshKey((key) => key + 1)}>
                Try again
              </Button>
            </div>
          ) : null}

          {loadState.kind === "ready" && items.length === 0 ? (
            <p className="py-8 text-ui text-cg-muted-strong">
              No live chat has MCP servers configured. Add one in Settings, under Skills &amp; MCP; chats started after that run it.
            </p>
          ) : null}

          {loadState.kind === "ready" && groups.length > 0 ? (
            <div className="flex flex-col gap-5">
              {groups.map((group) => (
                <section key={group.id ?? "missing-workspace"} aria-label={group.name}>
                  <h3 className="mb-2 border-b border-cg-line pb-1.5 text-small font-semibold text-cg-muted-strong">
                    {group.name}
                  </h3>
                  <ul className="flex flex-col divide-y divide-cg-line">
                    {group.items.map((item) => {
                      const key = rowKey(item);
                      const isStopping = stopping === key;
                      return (
                        <li key={key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="text-ui font-medium text-cg-ink">{item.serverName}</span>
                              <span className={`text-small font-medium ${statusTone(item)}`}>
                                {statusLabel(item)}
                              </span>
                              {item.pid !== null ? (
                                <code className="font-mono text-small text-cg-muted-strong">PID {item.pid}</code>
                              ) : null}
                            </div>
                            <p className="mt-1 truncate text-small text-cg-muted-strong">
                              {item.sessionTitle} · {item.provider}
                            </p>
                            {item.status === "remote" ? (
                              <p className="mt-1 text-small text-cg-muted-strong">Remote server; it has no local PID.</p>
                            ) : item.status === "notDetected" ? (
                              <p className="mt-1 text-small text-cg-muted-strong">
                                No matching process was found. The harness may start it only when needed.
                              </p>
                            ) : item.status === "unidentified" ? (
                              <p className="mt-1 text-small text-cg-muted-strong">
                                Ataraxia could not safely match a PID, so individual stop is unavailable.
                              </p>
                            ) : null}
                          </div>
                          <div className="flex flex-none items-center gap-2">
                            <Button
                              aria-label={`Open ${item.sessionTitle} in ${group.name}`}
                              className="max-w-56 truncate"
                              size="sm"
                              variant="quiet"
                              onClick={() => void openSession(item.sessionId)}
                            >
                              <ExternalLink aria-hidden="true" size={13} />
                              {group.name}
                            </Button>
                            {item.status === "running" ? (
                              <Button
                                aria-label={`Stop ${item.serverName} process ${item.pid}`}
                                disabled={isStopping || stopping !== null}
                                size="sm"
                                variant="danger"
                                onClick={() => void stopProcess(item)}
                              >
                                {isStopping ? (
                                  <Loader2 aria-hidden="true" className="animate-spin" size={13} />
                                ) : (
                                  <Square aria-hidden="true" size={12} />
                                )}
                                {isStopping ? "Stopping…" : "Stop"}
                              </Button>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          ) : null}
        </div>

        <footer className="border-t border-cg-line px-5 py-3 text-small text-cg-muted-strong">
          Stop terminates the identified MCP process and its child processes for that chat. The harness stays open.
        </footer>
      </div>
    </Dialog>
  );
}
