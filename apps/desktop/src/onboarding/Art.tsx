import { Bot, Brain, CheckCircle2, GitCommitHorizontal, ListChecks, MessageCircle, MousePointer2, ScanSearch, ScrollText } from "lucide-react";

/** The frame the drawings sit in: the same panel the screenshots have around them. */
function Stage({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div aria-label={label} className="grid h-full w-full place-items-center bg-cg-tint p-6" role="img">
      {children}
    </div>
  );
}

function Welcome() {
  const chips = [
    { icon: MessageCircle, text: "Chat" },
    { icon: ScanSearch, text: "Review" },
    { icon: ScrollText, text: "Decide" },
  ];
  return (
    <Stage label="Ataraxia: chat, review and decide">
      <div className="flex flex-col items-center gap-5">
        <p className="text-[34px] font-semibold tracking-[0.34em] text-cg-ink">ATARAXIA</p>
        <div className="flex gap-2.5">
          {chips.map(({ icon: Icon, text }) => (
            <span key={text} className="flex items-center gap-1.5 rounded-full border border-cg-line-strong bg-cg-panel px-3.5 py-1.5 text-ui text-cg-ink">
              <Icon aria-hidden="true" className="text-cg-accent" size={14} />
              {text}
            </span>
          ))}
        </div>
      </div>
    </Stage>
  );
}

function Workflow() {
  const steps = [
    { icon: MessageCircle, title: "Ask", text: "Chat with the agent" },
    { icon: ScanSearch, title: "Review", text: "Riskiest first" },
    { icon: ScrollText, title: "Decide", text: "Your verdict, on record" },
    { icon: GitCommitHorizontal, title: "Ship", text: "Commit with reasons" },
  ];
  return (
    <Stage label="Ask, review, decide, ship">
      <ol className="relative flex w-full max-w-[520px] items-start justify-between">
        <span aria-hidden="true" className="absolute top-[22px] right-10 left-10 h-px bg-cg-line-strong" />
        {steps.map(({ icon: Icon, title, text }, index) => (
          <li key={title} className="relative z-10 flex w-[112px] flex-col items-center gap-2 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-full border border-cg-line-strong bg-cg-panel text-cg-accent">
              <Icon aria-hidden="true" size={18} />
            </span>
            <span className="text-ui font-semibold text-cg-ink">
              {index + 1}. {title}
            </span>
            <span className="text-small text-cg-muted-strong">{text}</span>
          </li>
        ))}
      </ol>
    </Stage>
  );
}

function Browser() {
  const rows: [string, string, string][] = [
    ["200", "GET", "/api/orders?page=1"],
    ["401", "POST", "/api/login"],
    ["200", "GET", "/api/orders?page=2"],
  ];
  return (
    <Stage label="A browser window where an agent's mouse clicks Sign in, with the page's requests listed under it">
      <div className="w-full max-w-[470px] overflow-hidden rounded-cg-md border border-cg-line-strong bg-cg-panel shadow-cg-float">
        <div className="flex items-center gap-1.5 border-b border-cg-line px-2.5 py-1.5">
          <span className="flex items-center gap-1.5 rounded-t-cg-sm bg-cg-tint px-2.5 py-1 text-small text-cg-ink">shop.test</span>
          <span className="flex items-center gap-1 text-small text-cg-accent">
            <Bot aria-hidden="true" size={12} /> Agent tab
          </span>
        </div>
        <div className="relative h-[132px] px-5 py-4">
          <p className="text-ui font-semibold text-cg-ink">Sign in</p>
          <div className="mt-2 h-7 w-44 rounded-cg-sm border border-cg-line" />
          <div className="mt-1.5 h-7 w-44 rounded-cg-sm border border-cg-line" />
          <span className="mt-2.5 inline-block rounded-cg-sm bg-cg-primary px-3 py-1 text-small font-medium text-cg-on-primary ring-2 ring-cg-accent">Sign in</span>
          <MousePointer2 aria-hidden="true" className="absolute top-[108px] left-[88px] fill-cg-accent text-cg-panel" size={20} />
          <span className="absolute top-[124px] left-[108px] rounded-full bg-cg-accent px-2 py-0.5 text-[11px] font-semibold text-white">click “Sign in”</span>
        </div>
        <div className="border-t border-cg-line bg-cg-tint px-3 py-2 font-mono text-small">
          {rows.map(([status, method, path]) => (
            <p key={path} className="flex gap-3">
              <span className={status === "200" ? "text-cg-ink" : "text-cg-red"}>{status}</span>
              <span className="text-cg-muted-strong">{method}</span>
              <span className="text-cg-ink">{path}</span>
            </p>
          ))}
        </div>
      </div>
    </Stage>
  );
}

function Memory() {
  const nodes: { x: number; y: number; label: string; hub?: boolean }[] = [
    { x: 150, y: 90, label: "Answers in Portuguese", hub: true },
    { x: 70, y: 38, label: "Run the linter" },
    { x: 238, y: 40, label: "Uploads retry bug" },
    { x: 62, y: 142, label: "Tokens: SHA-256" },
    { x: 246, y: 146, label: "Deploy checklist" },
  ];
  return (
    <Stage label="A graph of shared memories next to a numbered task">
      <div className="flex w-full max-w-[520px] items-center gap-4">
        <svg aria-hidden="true" className="h-[184px] w-[300px] flex-none" viewBox="0 0 300 184">
          {nodes.slice(1).map((node) => (
            <line key={node.label} className="stroke-cg-line-strong" strokeWidth="1.2" x1={nodes[0]!.x} x2={node.x} y1={nodes[0]!.y} y2={node.y} />
          ))}
          {nodes.map((node) => (
            <g key={node.label}>
              <circle className={node.hub ? "fill-cg-accent" : "fill-cg-panel stroke-cg-line-strong"} cx={node.x} cy={node.y} r={node.hub ? 9 : 6} />
              <text className="fill-cg-muted-strong" fontSize="10" textAnchor="middle" x={node.x} y={node.y + (node.hub ? 24 : 19)}>
                {node.label}
              </text>
            </g>
          ))}
        </svg>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="flex items-center gap-1.5 text-small font-semibold text-cg-muted-strong">
            <Brain aria-hidden="true" size={13} /> Shared by every chat
          </p>
          <div className="rounded-cg-md border border-cg-line-strong bg-cg-panel p-2.5 text-small">
            <p className="flex items-center gap-1.5 font-semibold text-cg-ink">
              <ListChecks aria-hidden="true" className="text-cg-accent" size={13} /> #12 Retry failed uploads
            </p>
            <p className="mt-0.5 text-cg-muted-strong">“Do #12” and the agent reads it.</p>
          </div>
          <p className="flex items-center gap-1.5 text-small text-cg-muted-strong">
            <CheckCircle2 aria-hidden="true" size={13} /> Check the deploy in 10 min
          </p>
        </div>
      </div>
    </Stage>
  );
}

export function Art({ art }: { art: "welcome" | "workflow" | "browser" | "memory" }) {
  switch (art) {
    case "welcome":
      return <Welcome />;
    case "workflow":
      return <Workflow />;
    case "browser":
      return <Browser />;
    case "memory":
      return <Memory />;
  }
}
