import { Check, ChevronRight, Copy, Loader2, X } from "lucide-react";
import { memo, useState } from "react";
import type { ToolItem } from "../lib/agent";
import {
  diffLines,
  parseToolInput,
  toolSummary,
  unifiedDiffLines,
  type DiffLine,
} from "./toolSummary";

const DIFF_CLASS: Record<DiffLine["kind"], string> = {
  add: "bg-cg-add-bg text-cg-add-fg",
  remove: "bg-cg-del-bg text-cg-del-fg",
  context: "text-cg-muted-strong",
};

const DIFF_MARK: Record<DiffLine["kind"], string> = {
  add: "+",
  remove: "-",
  context: " ",
};

function StatusIcon({ status }: { status: ToolItem["status"] }) {
  if (status === "running") {
    return <Loader2 aria-label="running" className="animate-spin text-cg-muted" size={14} />;
  }
  if (status === "done") {
    return (
      <Check
        aria-label="done"
        className="text-cg-green"
        size={14}
      />
    );
  }
  return <X aria-label="failed" className="text-cg-red" size={14} />;
}

function Label({ children }: { children: string }) {
  return (
    <div className="mb-1 text-small font-semibold text-cg-muted">
      {children}
    </div>
  );
}

function Block({ text, className }: { text: string; className?: string }) {
  return (
    <pre
      className={`max-h-64 overflow-auto rounded-cg-sm bg-cg-tint p-2.5 font-mono text-small leading-5 whitespace-pre-wrap ${className ?? ""}`}
    >
      {text}
    </pre>
  );
}

function DiffBlock({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-cg-md bg-cg-tint py-1.5 font-mono text-small leading-5">
      {lines.map((line, index) => (
        <div key={index} className={`px-2 whitespace-pre-wrap ${DIFF_CLASS[line.kind]}`}>
          {DIFF_MARK[line.kind]} {line.text}
        </div>
      ))}
    </pre>
  );
}

function fieldText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function InputView({ input }: { input: string }) {
  const parsed = parseToolInput(input);
  if (parsed.kind === "empty") {
    return null;
  }
  if (parsed.kind === "text") {
    return <Block text={parsed.text} />;
  }
  const fields = new Map(parsed.fields);
  const oldString = fields.get("old_string");
  const newString = fields.get("new_string");
  const hasPair = typeof oldString === "string" && typeof newString === "string";
  const diff = fields.get("diff");
  return (
    <div className="space-y-2">
      {parsed.fields
        .filter(([key]) => !(hasPair && (key === "old_string" || key === "new_string")))
        .filter(([key]) => key !== "diff")
        .map(([key, value]) => {
          const text = fieldText(value);
          const long = text.includes("\n") || text.length > 80;
          return (
            <div key={key}>
              <Label>{key}</Label>
              {long ? (
                <Block text={text} />
              ) : (
                <div className="font-mono text-small break-all">{text}</div>
              )}
            </div>
          );
        })}
      {hasPair ? (
        <div>
          <Label>change</Label>
          <DiffBlock lines={diffLines(oldString, newString)} />
        </div>
      ) : null}
      {typeof diff === "string" ? (
        <div>
          <Label>diff</Label>
          <DiffBlock lines={unifiedDiffLines(diff)} />
        </div>
      ) : null}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      aria-label="Copy output"
      className="rounded-cg-sm p-1 text-cg-muted hover:bg-cg-tint hover:text-cg-ink"
      type="button"
      onClick={() => {
        void copy();
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

// The cards the reader opened. A card scrolled out of the transcript is not kept in the page,
// so which ones were open is remembered here and not in the page.
const opened = new Set<string>();

/**
 * One tool call, closed by default. Its input and output (which can be long) are only put in
 * the page while it is open.
 */
export const ToolCard = memo(function ToolCard({
  tool,
  defaultOpen = false,
}: {
  tool: ToolItem;
  defaultOpen?: boolean;
}) {
  const summary = toolSummary(tool.input);
  const [open, setOpen] = useState(() => defaultOpen || opened.has(tool.callId));
  return (
    <details
      className="group rounded-cg-md border border-cg-line bg-cg-panel text-small hover:bg-cg-sidebar open:bg-cg-panel"
      open={open}
      onToggle={(event) => {
        const now = event.currentTarget.open;
        if (now) {
          opened.add(tool.callId);
        } else {
          opened.delete(tool.callId);
        }
        setOpen(now);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="shrink-0 text-cg-muted transition-transform group-open:rotate-90"
          size={14}
        />
        <span className="shrink-0 font-mono text-small font-semibold">{tool.name}</span>
        {summary ? (
          <span className="min-w-0 truncate font-mono text-small text-cg-muted">
            {summary}
          </span>
        ) : null}
        <span className="ml-auto shrink-0">
          <StatusIcon status={tool.status} />
        </span>
      </summary>
      {open ? (
      <div className="space-y-3 border-t border-cg-line px-3.5 py-3">
        <InputView input={tool.input} />
        {tool.output !== null && tool.output.length > 0 ? (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label>Output</Label>
              <CopyButton text={tool.output} />
            </div>
            <Block
              className={tool.status === "failed" ? "text-cg-del-fg" : ""}
              text={tool.output}
            />
          </div>
        ) : null}
        {tool.status === "running" && tool.output === null ? (
          <p className="text-small text-cg-muted">Waiting for the result…</p>
        ) : null}
      </div>
      ) : null}
    </details>
  );
});
