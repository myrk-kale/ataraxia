import { openUrl } from "@tauri-apps/plugin-opener";
import { isValidElement, memo, useRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import { codeText, languageOf, tableCopy } from "./markdownCopy";
import { Mermaid } from "./Mermaid";

/** A table, with a button that copies it as cells (tab separated, and as a table where HTML is taken). */
function CopyableTable({ children }: { children: ReactNode }) {
  const table = useRef<HTMLTableElement>(null);
  return (
    <div className="group/copy relative my-2">
      <div className="overflow-x-auto">
        <table ref={table} className="w-full border-collapse text-left text-small">
          {children}
        </table>
      </div>
      <CopyButton
        read={() => (table.current ? tableCopy(table.current) : { text: "" })}
        what="table"
      />
    </div>
  );
}

/** A fenced block: a `mermaid` one becomes a diagram, any other gets a button that copies its code. */
function CodeBlock({ children }: { children: ReactNode }) {
  const code = isValidElement<{ className?: string; children?: unknown }>(children) ? children.props : null;
  const text = codeText(code?.children);
  if (code && languageOf(code.className) === "mermaid") {
    return <Mermaid source={text} />;
  }
  return (
    <div className="group/copy relative my-2">
      <pre className="overflow-x-auto rounded-cg-md bg-cg-tint p-4.5 font-mono text-small leading-[1.95] [&>code]:bg-transparent [&>code]:p-0">
        {children}
      </pre>
      <CopyButton read={() => ({ text })} what="code" />
    </div>
  );
}

function openExternal(href: string | undefined) {
  if (href && /^https?:\/\//i.test(href)) {
    void openUrl(href).catch(() => undefined);
  }
}

const components: Components = {
  a: ({ href, children }) => (
    <a
      className="cursor-pointer text-cg-accent underline underline-offset-2"
      href={href}
      onClick={(event) => {
        event.preventDefault();
        openExternal(href);
      }}
    >
      {children}
    </a>
  ),
  p: ({ children }) => <p className="my-3.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-6">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  h1: ({ children }) => <h1 className="mt-5 mb-2 text-title font-semibold tracking-[-0.3px]">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-heading font-semibold tracking-[-0.2px]">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-1 text-body font-semibold">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-cg-line-strong pl-3 text-cg-muted-strong">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-cg-line" />,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ children }) => (
    <code className="rounded-cg-sm bg-cg-tint px-1.5 py-0.5 font-mono text-[0.85em]">
      {children}
    </code>
  ),
  table: ({ children }) => <CopyableTable>{children}</CopyableTable>,
  th: ({ children }) => (
    <th className="border-b border-cg-line-strong px-2 py-1 font-semibold">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-cg-line px-2 py-1">{children}</td>
  ),
};

/** Parsing is the costly part, so a message is parsed again only when its text changes. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
      {text}
    </ReactMarkdown>
  );
});
