import { Bot, Brain, CheckCircle2, ListChecks, Mic, Search } from "lucide-react";
import { useCurrentFrame } from "remotion";
import { Appear, Pointer, Pop, Scene, Typed, Window, progress } from "./kit";

const REQUESTS = [
  { status: "200", method: "GET", path: "/api/orders?page=1" },
  { status: "401", method: "POST", path: "/api/login" },
  { status: "200", method: "GET", path: "/api/orders?page=2" },
] as const;

export function BrowserScene() {
  const frame = useCurrentFrame();
  const submitted = frame >= 124;
  return (
    <Scene label="A browser tab an agent drives with a visible mouse, with the page's requests listed under it">
      <div className="relative w-[470px]">
        <Window title="Browser">
          <div className="flex items-center gap-2 border-b border-cg-line px-3 py-1.5 text-[12px]">
            <span className="rounded-md bg-cg-tint px-2.5 py-1 text-cg-ink">shop.test</span>
            <span className="flex items-center gap-1 text-cg-accent">
              <Bot aria-hidden="true" size={13} /> Agent tab
            </span>
          </div>
          <div className="h-[196px] px-5 py-4">
            <p className="text-[16px] font-semibold text-cg-ink">Sign in</p>
            <p className="mt-2 flex h-8 items-center rounded-[7px] border border-cg-line px-2.5 text-[13px] text-cg-ink">
              <Typed perSecond={22} start={52} text="ana@shop.test" />
            </p>
            <p className="mt-2 flex h-8 items-center rounded-[7px] border border-cg-line px-2.5 text-[13px] tracking-widest text-cg-ink">
              <Typed perSecond={22} start={92} text="••••••••" />
            </p>
            <span className="mt-3 inline-block rounded-[7px] bg-cg-primary px-3.5 py-1.5 text-[13px] font-medium text-cg-on-primary" style={{ outline: submitted ? "2px solid var(--color-cg-accent)" : "none" }}>
              Sign in
            </span>
          </div>
          <div className="h-[104px] border-t border-cg-line bg-cg-tint px-3.5 py-2.5 font-mono text-[13px]">
            {REQUESTS.map((request, index) => (
              <Appear key={request.path} at={128 + index * 14} lift={6}>
                <p className="flex gap-3 py-0.5">
                  <span className={request.status === "200" ? "text-cg-ink" : "text-cg-red"}>{request.status}</span>
                  <span className="text-cg-muted-strong">{request.method}</span>
                  <span className="text-cg-ink">{request.path}</span>
                </p>
              </Appear>
            ))}
          </div>
        </Window>
        <Pointer clickAt={122} path={[[0, 440, 60], [40, 150, 150], [84, 170, 190], [112, 90, 238], [200, 90, 238]]} />
        <Pop at={176} className="absolute -bottom-12 left-1/2 -translate-x-1/2">
          <span className="rounded-full bg-cg-primary px-3.5 py-1.5 text-[13px] font-medium whitespace-nowrap text-cg-on-primary">A script, not a thousand clicks</span>
        </Pop>
      </div>
    </Scene>
  );
}

const MEMORIES = [
  { x: 235, y: 92, label: "Answers in Portuguese", hub: true },
  { x: 80, y: 40, label: "Run the linter" },
  { x: 390, y: 40, label: "Uploads retry bug" },
  { x: 76, y: 150, label: "Tokens: SHA-256" },
  { x: 394, y: 152, label: "Deploy checklist" },
] as const;

export function MemoryScene() {
  const frame = useCurrentFrame();
  return (
    <Scene label="A graph of memories shared by every chat, next to a numbered task">
      <div className="flex w-[470px] flex-col gap-5">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold text-cg-muted-strong">
          <Brain aria-hidden="true" size={15} /> Shared by every chat
        </div>
        <svg aria-hidden="true" className="overflow-visible" height="190" viewBox="0 0 470 190" width="470">
          {MEMORIES.slice(1).map((node, index) => (
            <line key={node.label} className="stroke-cg-line-strong" strokeDasharray={1} strokeDashoffset={1 - progress(frame, 20 + index * 8, 22)} pathLength={1} strokeWidth="1.5" x1={MEMORIES[0].x} x2={node.x} y1={MEMORIES[0].y} y2={node.y} />
          ))}
          {MEMORIES.map((node, index) => {
            const shown = progress(frame, 4 + index * 7, 14, (value) => value);
            const hub = "hub" in node;
            return (
              <g key={node.label} style={{ opacity: shown, translate: `0px ${(1 - shown) * 8}px` }}>
                <circle className={hub ? "fill-cg-accent" : "fill-cg-panel stroke-cg-line-strong"} cx={node.x} cy={node.y} r={hub ? 12 : 8} strokeWidth="1.5" />
                {hub ? <circle className="fill-none stroke-cg-accent" cx={node.x} cy={node.y} opacity={(1 - ((frame % 60) / 60)) * 0.6} r={12 + ((frame % 60) / 60) * 14} /> : null}
                <text className="fill-cg-muted-strong stroke-cg-tint" fontSize="12" paintOrder="stroke" strokeLinejoin="round" strokeWidth="5" textAnchor="middle" x={node.x} y={node.y + (hub ? 32 : 26)}>
                  {node.label}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="grid grid-cols-[1fr_auto] items-start gap-4">
          <Appear at={80}>
            <div className="rounded-[10px] border border-cg-line-strong bg-cg-panel p-3 shadow-cg-float">
              <p className="flex items-center gap-1.5 text-[14px] font-semibold text-cg-ink">
                <ListChecks aria-hidden="true" className="text-cg-accent" size={15} /> #12 Retry failed uploads
              </p>
              {frame >= 150 ? (
                <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-cg-green">
                  <CheckCircle2 aria-hidden="true" size={14} /> Agent read #12
                </p>
              ) : (
                <p className="mt-1.5 text-[13px] text-cg-muted-strong">Task, kept in Ataraxia</p>
              )}
            </div>
          </Appear>
          <Appear at={110}>
            <p className="rounded-[14px] rounded-br-[4px] bg-cg-bubble px-3.5 py-2 text-[14px] text-cg-ink">
              <Typed start={112} text="Do #12" />
            </p>
          </Appear>
        </div>
      </div>
    </Scene>
  );
}

const THEMES = [
  { name: "Light", canvas: "#f4f2ee", panel: "#ffffff", ink: "#23211f", accent: "#5b8def" },
  { name: "Dark", canvas: "#151618", panel: "#212326", ink: "#ecebe8", accent: "#8b7cc8" },
  { name: "Warm", canvas: "#efe3cf", panel: "#faf3e5", ink: "#3b2f22", accent: "#d98b2b" },
] as const;

function PetBlob({ lift }: { lift: number }) {
  return (
    <svg aria-hidden="true" height="64" style={{ translate: `0px ${-lift}px` }} viewBox="0 0 64 64" width="64">
      <path d="M32 6c14 0 22 12 22 28 0 14-8 24-22 24S10 48 10 34C10 18 18 6 32 6z" fill="#8b7cc8" />
      <circle cx="24" cy="34" fill="#1c1b1a" r="3.2" />
      <circle cx="40" cy="34" fill="#1c1b1a" r="3.2" />
      <path d="M26 43q6 5 12 0" fill="none" stroke="#1c1b1a" strokeLinecap="round" strokeWidth="2.4" />
    </svg>
  );
}

export function YoursScene() {
  const frame = useCurrentFrame();
  const current = Math.min(2, Math.floor(Math.max(0, frame - 24) / 40));
  const hop = Math.abs(Math.sin(frame / 7)) * 14;
  return (
    <Scene label="Themes that change the look, an optional companion, search and dictation">
      <div className="flex w-[470px] flex-col items-center gap-7">
        <div className="grid w-full grid-cols-3 gap-3">
          {THEMES.map((theme, index) => (
            <Pop key={theme.name} at={6 + index * 8}>
              <div className="overflow-hidden rounded-[12px] border-2 p-2.5" style={{ background: theme.canvas, borderColor: index === current ? "var(--color-cg-accent)" : "transparent", scale: index === current ? 1.05 : 1 }}>
                <div className="rounded-[7px] p-2" style={{ background: theme.panel }}>
                  <span className="block h-2 w-10 rounded-full" style={{ background: theme.accent }} />
                  <span className="mt-2 block h-1.5 w-full rounded-full" style={{ background: theme.ink, opacity: 0.55 }} />
                  <span className="mt-1.5 block h-1.5 w-2/3 rounded-full" style={{ background: theme.ink, opacity: 0.3 }} />
                </div>
                <p className="mt-2 text-center text-[12px] font-semibold" style={{ color: theme.ink }}>
                  {theme.name}
                </p>
              </div>
            </Pop>
          ))}
        </div>
        <Appear at={60} className="flex items-end gap-3">
          <PetBlob lift={hop} />
          <p className="mb-3 rounded-[12px] rounded-bl-[3px] border border-cg-line-strong bg-cg-panel px-3 py-1.5 text-[13px] text-cg-ink shadow-cg-float">
            <Typed start={74} text="Done: retry uploads" />
          </p>
        </Appear>
        <div className="flex items-center gap-3">
          <Appear at={100}>
            <span className="flex h-11 items-center gap-2.5 rounded-full border border-cg-line-strong bg-cg-panel px-4 shadow-cg-float">
              <Mic aria-hidden="true" className="text-cg-accent" size={17} />
              <span className="flex h-5 items-center gap-[3px]">
                {Array.from({ length: 12 }, (_, bar) => (
                  <span key={bar} className="w-[3px] rounded-full bg-cg-accent" style={{ height: 4 + Math.abs(Math.sin(frame / 4 + bar * 0.9)) * 14 }} />
                ))}
              </span>
            </span>
          </Appear>
          <Appear at={116}>
            <span className="flex h-11 w-[200px] items-center gap-2 rounded-full border border-cg-line-strong bg-cg-panel px-4 text-[13px] text-cg-muted-strong shadow-cg-float">
              <Search aria-hidden="true" size={15} />
              <span className="text-cg-ink">
                <Typed start={130} text="retry decision" />
              </span>
            </span>
          </Appear>
        </div>
      </div>
    </Scene>
  );
}
