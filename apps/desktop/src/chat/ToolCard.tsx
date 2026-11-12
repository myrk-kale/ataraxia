import { Check, ChevronRight, Copy, Loader2, X } from "lucide-react";
import { useState } from "react";
import type { ToolItem } from "../lib/agent";
import {
  diffLines,
  parseToolInput,
  toolSummary,
  unifiedDiffLines,
  type DiffLine,
} from "./toolSummary";

const DIFF_CLASS: Record<DiffLine["kind"], string> = {
  add: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  remove: "bg-red-500/15 text-red-700 dark:text-red-300",
  context: "text-foreground/60",
};

const DIFF_MARK: Record<DiffLine["kind"], string> = {
  add: "+",
  remove: "-",
  context: " ",
};

function StatusIcon({ status }: { status: ToolItem["status"] }) {
  if (status === "running") {
    return <Loader2 aria-label="running" className="animate-spin" size={14} />;
  }
  if (status === "done") {
    return (
      <Check
        aria-label="done"
        className="text-emerald-600 dark:text-emerald-400"
        size={14}
      />
    );
  }
  return <X aria-label="failed" className="text-red-600 dark:text-red-400" size={14} />;
}

function Label({ children }: { children: string }) {
  return (
    <div className="mb-1 text-[11px] tracking-wide text-foreground/40 uppercase">
      {children}
    </div>
  );
}

function Block({ text, className }: { text: string; className?: string }) {
  return (
    <pre
      className={`max-h-64 overflow-auto rounded-md bg-foreground/[0.05] p-2 font-mono text-xs leading-5 whitespace-pre-wrap ${className ?? ""}`}
    >
      {text}
    </pre>
  );
}

function DiffBlock({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-foreground/[0.05] py-1 font-mono text-xs leading-5">
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
                <div className="font-mono text-xs break-all">{text}</div>
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
      className="rounded p-1 text-foreground/50 hover:bg-foreground/10 hover:text-foreground"
      type="button"
      onClick={() => {
        void copy();
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

export function ToolCard({ tool }: { tool: ToolItem }) {
  const summary = toolSummary(tool.input);
  return (
    <details className="group rounded-lg border border-foreground/10 bg-foreground/[0.03] text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="shrink-0 text-foreground/40 transition-transform group-open:rotate-90"
          size={14}
        />
        <span className="shrink-0 font-mono text-xs font-medium">{tool.name}</span>
        {summary ? (
          <span className="min-w-0 truncate font-mono text-xs text-foreground/50">
            {summary}
          </span>
        ) : null}
        <span className="ml-auto shrink-0">
          <StatusIcon status={tool.status} />
        </span>
      </summary>
      <div className="space-y-3 border-t border-foreground/10 px-3 py-3">
        <InputView input={tool.input} />
        {tool.output !== null && tool.output.length > 0 ? (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label>Output</Label>
              <CopyButton text={tool.output} />
            </div>
            <Block
              className={tool.status === "failed" ? "text-red-700 dark:text-red-300" : ""}
              text={tool.output}
            />
          </div>
        ) : null}
        {tool.status === "running" && tool.output === null ? (
          <p className="text-xs text-foreground/50">Waiting for the result…</p>
        ) : null}
      </div>
    </details>
  );
}
