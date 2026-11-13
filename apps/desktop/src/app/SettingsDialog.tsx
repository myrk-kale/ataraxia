import { useEffect, useState } from "react";
import {
  settingsMcpInfo,
  type McpInfo,
} from "../lib/insights";
import { PROVIDER_LABELS } from "../lib/agent";
import type { Repository, ProviderKind } from "../lib/workspace";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Overlay";

/** The configuration as indented JSON; text that is not valid JSON is shown as it came. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function SettingsDialog({
  isOpen,
  repository,
  provider,
  onClose,
  onError,
}: {
  isOpen: boolean;
  repository: Repository | null;
  provider: ProviderKind | null;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [mcp, setMcp] = useState<McpInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const repositoryId = repository?.id ?? null;

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setCopied(false);
    settingsMcpInfo()
      .then(setMcp)
      .catch(() => setMcp(null));
  }, [isOpen, repositoryId, onError]);

  return (
    <Dialog isOpen={isOpen} label="Settings" size="md" onClose={onClose}>
      <div className="flex flex-col gap-6 p-6">
        <h2 className="text-heading font-semibold text-cg-ink">Settings</h2>

        <section className="flex flex-col gap-2">
          <h3 className="text-small font-semibold text-cg-muted-strong">Privacy</h3>
          <p className="text-small leading-5 text-cg-muted-strong">
            Nothing is sent to a model by itself. The review queue is computed on this machine from the syntax tree and
            git. Decisions, diagrams and BTW questions run only when you start them, on the provider you pick
            {provider ? ` (this chat uses ${PROVIDER_LABELS[provider]})` : ""}, and then that provider receives the diff.
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-small font-semibold text-cg-muted-strong">MCP server</h3>
          <p className="text-small leading-5 text-cg-muted">
            Claude Code gets it automatically, scoped to its own chat. For other agents, register this command. It is
            read-only unless you add <code className="font-mono text-small">--allow-write</code>, and every call is logged.
          </p>
          {mcp ? (
            <>
              <pre
                aria-label="MCP configuration"
                className="max-h-[130px] overflow-auto rounded-cg-md bg-cg-tint p-3 font-mono text-small leading-5 whitespace-pre-wrap text-cg-muted-strong"
              >
                {prettyJson(mcp.configJson)}
              </pre>
              <div>
                <Button
                  variant="quiet"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(mcp.configJson)
                      .then(() => setCopied(true))
                      .catch(() => undefined);
                  }}
                >
                  {copied ? "Copied" : "Copy configuration"}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-small text-cg-muted">Available in the desktop app.</p>
          )}
        </section>
      </div>
    </Dialog>
  );
}
