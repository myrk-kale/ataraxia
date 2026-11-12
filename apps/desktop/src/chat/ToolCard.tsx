import type { ToolItem } from "../lib/agent";

const STATUS_LABEL: Record<ToolItem["status"], string> = {
  running: "running",
  done: "done",
  failed: "failed",
};

const STATUS_CLASS: Record<ToolItem["status"], string> = {
  running: "bg-foreground/10 text-foreground/70",
  done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
};

export function ToolCard({ tool }: { tool: ToolItem }) {
  return (
    <details className="group rounded-lg border border-foreground/10 bg-foreground/[0.03] text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
        <span className="font-mono text-xs">{tool.name}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_CLASS[tool.status]}`}
        >
          {STATUS_LABEL[tool.status]}
        </span>
        <span className="ml-auto text-xs text-foreground/40 group-open:hidden">
          show
        </span>
        <span className="ml-auto hidden text-xs text-foreground/40 group-open:inline">
          hide
        </span>
      </summary>
      <div className="space-y-2 border-t border-foreground/10 px-3 py-2">
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-foreground/40">
            Input
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">
            {tool.input}
          </pre>
        </div>
        {tool.output !== null ? (
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-foreground/40">
              Output
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">
              {tool.output}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}
