import { Check, FileCode2, GitCommitHorizontal, MessageSquare, TriangleAlert } from "lucide-react";
import { interpolate, useCurrentFrame } from "remotion";
import { Appear, Keycap, Pointer, Pop, Scene, Typed, Window, progress } from "./kit";

const ROW = 46;
const QUEUE = [
  { name: "formatDate()", score: 34 },
  { name: "uploadFile()", score: 92 },
  { name: "README.md", score: 8 },
  { name: "parseConfig()", score: 71 },
] as const;

function tone(score: number): string {
  return score >= 70 ? "var(--color-cg-red)" : score >= 30 ? "var(--color-cg-amber)" : "var(--color-cg-green)";
}

export function ReviewScene() {
  const frame = useCurrentFrame();
  const sorted = [...QUEUE].sort((a, b) => b.score - a.score);
  const move = progress(frame, 92, 26);
  return (
    <Scene label="A review queue ranked by risk, with a comment on a changed line">
      <div className="flex w-[470px] flex-col gap-4">
        <Window title="Review queue">
          <div className="relative p-3" style={{ height: ROW * QUEUE.length + 24 }}>
            {QUEUE.map((item, from) => {
              const to = sorted.findIndex((entry) => entry.name === item.name);
              const y = (from + (to - from) * move) * ROW;
              const fill = progress(frame, 18 + from * 8, 36);
              const picked = to === 0 && frame > 130;
              return (
                <div key={item.name} className="absolute right-3 left-3 flex items-center gap-3 rounded-[9px] px-3" style={{ top: 12 + y, height: ROW - 6, background: picked ? "var(--color-cg-accent-bg)" : "transparent", opacity: progress(frame, 6 + from * 6) }}>
                  <span className="w-[118px] font-mono text-[14px] text-cg-ink">{item.name}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-cg-tint">
                    <span className="block h-full rounded-full" style={{ width: `${item.score * fill}%`, background: tone(item.score) }} />
                  </span>
                  <span className="w-7 text-right font-mono text-[14px] font-semibold text-cg-ink">{Math.round(item.score * fill)}</span>
                </div>
              );
            })}
          </div>
        </Window>
        <Appear at={134} lift={20}>
          <div className="relative overflow-hidden rounded-[14px] border border-cg-line-strong bg-cg-panel font-mono text-[13px] shadow-cg-float">
            <p className="flex items-center gap-2 border-b border-cg-line px-3.5 py-2 text-[12px] text-cg-muted-strong">
              <FileCode2 aria-hidden="true" size={13} /> uploadFile()
            </p>
            <p className="bg-cg-del-bg px-3.5 py-1 text-cg-del-fg">- await send(file);</p>
            <p className="bg-cg-add-bg px-3.5 py-1 text-cg-add-fg">+ await retry(() =&gt; send(file));</p>
            <Pop at={176} className="absolute right-3 bottom-2.5">
              <span className="flex items-center gap-1.5 rounded-full bg-cg-accent px-3 py-1 font-sans text-[12px] font-semibold text-white">
                <MessageSquare aria-hidden="true" size={12} /> Retry on 5xx only?
              </span>
            </Pop>
            <span className="block h-9" />
          </div>
        </Appear>
      </div>
    </Scene>
  );
}

export function DecisionsScene() {
  const frame = useCurrentFrame();
  const approved = frame >= 114;
  const options = [
    { title: "Exponential backoff", text: "Small, no new moving parts" },
    { title: "Persistent queue", text: "Needs a table and a worker" },
  ];
  return (
    <Scene label="A decision with two options, a thread and an approval linked to a commit">
      <div className="relative w-[470px]">
        <Window title="Decision">
          <div className="flex flex-col gap-4 p-5">
            <Appear at={6}>
              <p className="text-[12px] font-semibold tracking-wide text-cg-accent uppercase">Needs your verdict</p>
              <p className="mt-1 text-[20px] font-semibold text-cg-ink">How should failed uploads be retried?</p>
            </Appear>
            <div className="grid grid-cols-2 gap-3">
              {options.map((option, index) => {
                const chosen = approved && index === 0;
                return (
                  <Appear key={option.title} at={22 + index * 10}>
                    <div
                      className="h-[92px] rounded-[10px] border p-3"
                      style={{ borderColor: chosen ? "var(--color-cg-green)" : "var(--color-cg-line-strong)", background: chosen ? "var(--color-cg-add-bg)" : "transparent", opacity: approved && !chosen ? 0.55 : 1 }}
                    >
                      <p className="flex items-center gap-1.5 text-[15px] font-semibold text-cg-ink">
                        {chosen ? <Check aria-hidden="true" className="text-cg-green" size={15} /> : null}
                        {option.title}
                      </p>
                      <p className="mt-1 text-[13px] text-cg-muted-strong">{option.text}</p>
                    </div>
                  </Appear>
                );
              })}
            </div>
            <Appear at={58}>
              <p className="rounded-[10px] bg-cg-tint px-3 py-2 text-[13px] text-cg-muted-strong">
                <span className="font-semibold text-cg-ink">You: </span>
                <Typed start={60} text="Why not a queue?" />
                {frame >= 84 ? <span className="mt-1 block"><span className="font-semibold text-cg-ink">Agent: </span><Typed start={84} text="It adds a worker for a rare case." /></span> : null}
              </p>
            </Appear>
            <div className="flex items-center justify-between">
              <span className="h-[34px]">
                {frame >= 140 ? (
                  <Pop at={140}>
                    <span className="flex items-center gap-1.5 rounded-full border border-cg-line-strong px-3 py-1.5 font-mono text-[12px] text-cg-ink">
                      <GitCommitHorizontal aria-hidden="true" className="text-cg-accent" size={14} /> a1b2c3d retry uploads
                    </span>
                  </Pop>
                ) : null}
              </span>
              <span className="rounded-[9px] px-4 py-2 text-[14px] font-medium" style={{ background: approved ? "var(--color-cg-green)" : "var(--color-cg-primary)", color: approved ? "#fff" : "var(--color-cg-on-primary)" }}>
                {approved ? "Approved" : "Approve"}
              </span>
            </div>
          </div>
        </Window>
        <Pointer clickAt={112} path={[[0, 520, 40], [62, 470, 150], [96, 410, 340], [112, 405, 322], [200, 405, 322]]} />
      </div>
    </Scene>
  );
}

const NODES = [
  { id: "a", x: 260, y: 56, name: "uploadFile()", file: "upload.ts" },
  { id: "b", x: 120, y: 190, name: "retry()", file: "retry.ts" },
  { id: "c", x: 400, y: 190, name: "logError()", file: "log.ts" },
  { id: "d", x: 120, y: 324, name: "api.post()", file: "api.ts" },
  { id: "e", x: 400, y: 324, name: "queue.add()", file: "queue.ts" },
] as const;
const EDGES = [
  ["a", "b"],
  ["a", "c"],
  ["b", "d"],
  ["c", "e"],
] as const;

export function FlowScene() {
  const frame = useCurrentFrame();
  const at = (id: string) => NODES.find((node) => node.id === id)!;
  const stale = progress(frame, 150, 14);
  return (
    <Scene label="A flow diagram whose nodes point at files, one marked out of date">
      <svg aria-hidden="true" className="overflow-visible" height="400" viewBox="0 0 520 400" width="520">
        {EDGES.map(([from, to], index) => {
          const a = at(from);
          const b = at(to);
          return (
            <path
              key={from + to}
              className="fill-none stroke-cg-line-strong"
              d={`M ${a.x} ${a.y + 24} C ${a.x} ${(a.y + b.y) / 2 + 8}, ${b.x} ${(a.y + b.y) / 2 - 8}, ${b.x} ${b.y - 24}`}
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - progress(frame, 24 + index * 18, 26)}
              strokeWidth="2"
            />
          );
        })}
        {NODES.map((node, index) => {
          const shown = progress(frame, 8 + index * 16, 14);
          const old = node.id === "e";
          return (
            <g key={node.id} style={{ opacity: shown, translate: `0px ${(1 - shown) * 10}px` }}>
              <rect className="fill-cg-panel" height="48" rx="10" stroke={old && stale > 0.5 ? "var(--color-cg-amber)" : "var(--color-cg-line-strong)"} strokeWidth={old && stale > 0.5 ? 2 : 1.2} width="150" x={node.x - 75} y={node.y - 24} />
              <text className="fill-cg-ink" fontFamily="var(--font-mono, monospace)" fontSize="14" fontWeight="600" textAnchor="middle" x={node.x} y={node.y - 2}>
                {node.name}
              </text>
              <text className="fill-cg-muted-strong" fontSize="11" textAnchor="middle" x={node.x} y={node.y + 14}>
                {node.file}
              </text>
            </g>
          );
        })}
      </svg>
      <Pop at={150} className="absolute" style={{ left: 338, top: 432 }}>
        <span className="flex items-center gap-1.5 rounded-full bg-cg-amber px-3 py-1 text-[12px] font-semibold text-white" style={{ opacity: stale }}>
          <TriangleAlert aria-hidden="true" size={13} /> The code moved on
        </span>
      </Pop>
    </Scene>
  );
}

export function BtwScene() {
  const frame = useCurrentFrame();
  const bar = progress(frame, 30, 20);
  return (
    <Scene label="A side question asked with a shortcut, answered without touching the main chat">
      <div className="absolute top-[70px] flex w-[470px] flex-col gap-2.5 opacity-60">
        {[330, 410, 260, 380].map((width, index) => (
          <span key={index} className="h-2.5 rounded-full bg-cg-line-strong" style={{ width, opacity: progress(frame, index * 5) }} />
        ))}
      </div>
      <div className="absolute top-[170px] flex items-center gap-2">
        <Keycap pressedAt={14}>Ctrl/⌘</Keycap>
        <span className="text-cg-muted-strong">+</span>
        <Keycap pressedAt={14}>K</Keycap>
      </div>
      <div className="absolute bottom-[110px] w-[470px] rounded-[14px] border border-cg-line-strong bg-cg-panel p-4 shadow-cg-pop" style={{ opacity: bar, translate: `0px ${(1 - bar) * 40}px` }}>
        <p className="text-[16px] text-cg-ink">
          <Typed start={54} text="Why does retry() wait 2 seconds?" />
          <span className="text-cg-accent">{frame < 100 ? "|" : ""}</span>
        </p>
        {frame >= 104 ? (
          <Appear at={104} lift={8}>
            <p className="mt-3 border-t border-cg-line pt-3 text-[14px] leading-snug text-cg-muted-strong">
              <Typed perSecond={40} start={106} text="The delay doubles on every try and starts at 2 seconds, to give a busy server room." />
            </p>
            <div className="mt-3 flex gap-2 text-[12px]">
              <span className="rounded-full bg-cg-tint px-2.5 py-1 text-cg-muted-strong">Knows: retry.ts</span>
              <span className="rounded-full bg-cg-tint px-2.5 py-1 text-cg-muted-strong">Read-only</span>
              <span className="rounded-full bg-cg-tint px-2.5 py-1 text-cg-muted-strong" style={{ opacity: interpolate(frame, [150, 164], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
                Main chat hears a summary
              </span>
            </div>
          </Appear>
        ) : null}
      </div>
    </Scene>
  );
}
