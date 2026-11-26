import { openUrl } from "@tauri-apps/plugin-opener";
import { isValidElement, memo, useMemo, useRef, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import { codeText, languageOf, tableCopy } from "./markdownCopy";
import { Mermaid } from "./Mermaid";
import { ObjectBlock } from "./ObjectBlock";
import { SvgBlock } from "./SvgBlock";
import { readFileHref, remarkFileLinks, useFileLinks, type FileLinks } from "./fileLinks";
import { resolveCite } from "./fileRefs";

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

/** A fenced block: `mermaid` becomes a diagram, `svg` a drawing and `object` a file of the local file server; any other gets a button that copies its code. */
function CodeBlock({ children }: { children: ReactNode }) {
  const code = isValidElement<{ className?: string; children?: unknown }>(children) ? children.props : null;
  const text = codeText(code?.children);
  if (code && languageOf(code.className) === "mermaid") {
    return <Mermaid source={text} />;
  }
  if (code && languageOf(code.className) === "svg") {
    return <SvgBlock source={text} />;
  }
  if (code && languageOf(code.className) === "object") {
    return <ObjectBlock source={text} />;
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

/** A link to a file of the chat: it opens in the editor, at the lines it names. */
function FileLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const links = useFileLinks();
  // What the writer put in the link, when it is not one the app made: a path, with or without lines.
  const cite = readFileHref(href) ?? (links && href ? resolveCite(links.index, safeDecode(href)) : null);
  if (!cite || !links) {
    return <>{children}</>;
  }
  const open = () => links.open(cite);
  return (
    <span
      className="cursor-pointer text-cg-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
      role="link"
      tabIndex={0}
      title={`Open ${cite.path}${cite.line ? `:${cite.line}${cite.endLine ? `-${cite.endLine}` : ""}` : ""} in the editor`}
      onClick={(event) => {
        event.preventDefault();
        open();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      {children}
    </span>
  );
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

const components: Components = {
  a: ({ href, children }) =>
    href && /^(?:https?:|mailto:)/i.test(href) ? (
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
    ) : (
      <FileLink href={href}>{children}</FileLink>
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

/**
 * Links are kept as written: what is not a web link only ever opens a file of the chat, or nothing.
 * Anything that is fetched (an image's source) still goes through the usual filter.
 */
const keepUrl = (url: string, key: string) => (key === "href" ? url : defaultUrlTransform(url));

/** Parsing is the costly part, so a message is parsed again only when its text or the files it can name change. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const links = useFileLinks();
  const plugins = useMemo(
    () => (links ? [remarkGfm, remarkFileLinks(links.index)] : [remarkGfm]),
    [links],
  );
  return (
    <ReactMarkdown components={components} remarkPlugins={plugins} urlTransform={keepUrl}>
      {text}
    </ReactMarkdown>
  );
});

export type { FileLinks };
