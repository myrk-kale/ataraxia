import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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
  h1: ({ children }) => <h1 className="mt-5 mb-2 text-[17px] font-semibold tracking-[-0.3px]">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-[15px] font-semibold tracking-[-0.2px]">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-1 text-body font-semibold">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-cg-line-strong pl-3 text-cg-muted-strong">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-cg-line" />,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-[9px] bg-cg-tint p-[15px] font-mono text-small leading-[1.95] [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded bg-cg-tint px-1.5 py-0.5 font-mono text-[0.85em]">
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-left text-small">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-cg-line-strong px-2 py-1 font-semibold">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-cg-line px-2 py-1">{children}</td>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
      {text}
    </ReactMarkdown>
  );
}
