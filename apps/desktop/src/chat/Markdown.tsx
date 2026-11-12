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
      className="cursor-pointer underline underline-offset-2"
      href={href}
      onClick={(event) => {
        event.preventDefault();
        openExternal(href);
      }}
    >
      {children}
    </a>
  ),
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-6">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-lg font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1 text-sm font-semibold">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-foreground/20 pl-3 text-foreground/70">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-foreground/15" />,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-foreground/[0.06] p-3 font-mono text-xs leading-5 [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]">
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-foreground/20 px-2 py-1 font-medium">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-foreground/10 px-2 py-1">{children}</td>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
      {text}
    </ReactMarkdown>
  );
}
