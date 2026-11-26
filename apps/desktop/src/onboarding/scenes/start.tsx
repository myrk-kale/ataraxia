import { Check, GitCommitHorizontal, MessageCircle, ScanSearch, ScrollText } from "lucide-react";
import { interpolate, useCurrentFrame } from "remotion";
import { Appear, Pop, Scene, Typed, Window, progress } from "./kit";

function Rings() {
  const frame = useCurrentFrame();
  return (
    <>
      {[0, 1, 2].map((ring) => {
        const phase = ((frame + ring * 45) % 135) / 135;
        return <span key={ring} className="absolute h-[260px] w-[260px] rounded-full border border-cg-accent" style={{ opacity: (1 - phase) * 0.32, scale: 0.35 + phase * 1.5 }} />;
      })}
    </>
  );
}

export function WelcomeScene() {
  const frame = useCurrentFrame();
  const word = "ATARAXIA";
  const spread = interpolate(frame, [0, 60], [0.9, 0.34], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const chips = [
    { icon: MessageCircle, text: "Chat" },
    { icon: ScanSearch, text: "Review" },
    { icon: ScrollText, text: "Decide" },
  ];
  return (
    <Scene label="Ataraxia: chat, review and decide">
      <Rings />
      <div className="relative flex flex-col items-center gap-7">
        <p aria-hidden="true" className="flex text-[44px] font-semibold text-cg-ink" style={{ letterSpacing: `${spread}em`, marginRight: `-${spread}em` }}>
          {word.split("").map((letter, index) => (
            <span key={index} style={{ opacity: progress(frame, 6 + index * 4), translate: `0px ${(1 - progress(frame, 6 + index * 4)) * 16}px` }}>
              {letter}
            </span>
          ))}
        </p>
        <div className="flex gap-3">
          {chips.map(({ icon: Icon, text }, index) => (
            <Pop key={text} at={52 + index * 12}>
              <span className="flex items-center gap-2 rounded-full border border-cg-line-strong bg-cg-panel px-4 py-2 text-[16px] text-cg-ink shadow-cg-float">
                <Icon aria-hidden="true" className="text-cg-accent" size={17} />
                {text}
              </span>
            </Pop>
          ))}
        </div>
        <Appear at={96}>
          <p className="text-[16px] text-cg-muted-strong">Agents write fast. You decide what ships.</p>
        </Appear>
      </div>
    </Scene>
  );
}

const STEPS = [
  { icon: MessageCircle, title: "Ask", text: "Chat with the agent" },
  { icon: ScanSearch, title: "Review", text: "Riskiest changes first" },
  { icon: ScrollText, title: "Decide", text: "Your verdict, on record" },
  { icon: GitCommitHorizontal, title: "Ship", text: "Commit with the reasons" },
] as const;

export function WorkflowScene() {
  const frame = useCurrentFrame();
  const gap = 104;
  const reached = progress(frame, 20, 130, (value) => value);
  return (
    <Scene label="Ask, review, decide, ship">
      <ol className="relative flex w-fit flex-col pr-6" style={{ gap: gap - 52 }}>
        <span aria-hidden="true" className="absolute top-[26px] left-[25px] w-px bg-cg-line-strong" style={{ height: gap * 3 }} />
        <span aria-hidden="true" className="absolute top-[26px] left-[24px] w-[3px] rounded-full bg-cg-accent" style={{ height: gap * 3 * reached }} />
        {STEPS.map(({ icon: Icon, title, text }, index) => {
          const at = 20 + index * 43;
          const on = progress(frame, at, 10);
          return (
            <li key={title} className="relative flex h-[52px] items-center gap-5">
              <span
                className="relative z-10 grid h-[52px] w-[52px] flex-none place-items-center rounded-full border"
                style={{
                  borderColor: on > 0.5 ? "var(--color-cg-accent)" : "var(--color-cg-line-strong)",
                  background: on > 0.5 ? "var(--color-cg-accent)" : "var(--color-cg-panel)",
                  color: on > 0.5 ? "#fff" : "var(--color-cg-muted-strong)",
                  scale: 1 + Math.sin(on * Math.PI) * 0.14,
                }}
              >
                <Icon aria-hidden="true" size={22} />
              </span>
              <Appear at={at} lift={10}>
                <p className="text-[20px] font-semibold text-cg-ink">
                  {index + 1}. {title}
                </p>
                <p className="text-[15px] text-cg-muted-strong">{text}</p>
              </Appear>
            </li>
          );
        })}
      </ol>
    </Scene>
  );
}

const AGENTS = ["Claude Code", "Codex", "OpenCode", "Cursor"] as const;

export function ChatScene() {
  const frame = useCurrentFrame();
  const active = frame < 70 ? 0 : frame < 100 ? 1 : frame < 130 ? 2 : 3;
  const dots = frame >= 96 && frame < 116;
  return (
    <Scene label="A chat with an agent: any agent, and messages that queue while it works">
      <Window className="w-[470px]" title="Chat">
        <div className="flex gap-1.5 border-b border-cg-line px-3.5 py-2.5">
          {AGENTS.map((agent, index) => (
            <Pop key={agent} at={6 + index * 6}>
              <span
                className="rounded-full border px-2.5 py-1 text-[12px] font-medium"
                style={{
                  borderColor: index === active ? "var(--color-cg-accent)" : "var(--color-cg-line)",
                  color: index === active ? "var(--color-cg-accent)" : "var(--color-cg-muted-strong)",
                  background: index === active ? "var(--color-cg-accent-bg)" : "transparent",
                }}
              >
                {agent}
              </span>
            </Pop>
          ))}
        </div>
        <div className="flex h-[250px] flex-col gap-3 px-4 py-4 text-[15px]">
          <Appear at={34} className="self-end">
            <p className="max-w-[300px] rounded-[14px] rounded-br-[4px] bg-cg-bubble px-3.5 py-2 text-cg-ink">
              <Typed start={36} text="Retry the upload when it fails" />
            </p>
          </Appear>
          {dots ? (
            <div className="flex gap-1.5 self-start px-1 py-2">
              {[0, 1, 2].map((dot) => (
                <span key={dot} className="h-2 w-2 rounded-full bg-cg-muted" style={{ translate: `0px ${Math.sin((frame - dot * 4) / 3) * -3}px` }} />
              ))}
            </div>
          ) : null}
          {frame >= 116 ? (
            <p className="max-w-[330px] self-start text-cg-ink">
              <Typed perSecond={34} start={116} text="On it. Retrying with backoff, and a test for the failed case." />
            </p>
          ) : null}
          <Appear at={150} className="mt-auto self-end">
            <p className="flex items-center gap-2 rounded-[14px] rounded-br-[4px] border border-dashed border-cg-line-strong px-3.5 py-2 text-cg-muted-strong">
              Also log the error
              <span className="rounded-full bg-cg-amber/20 px-2 py-0.5 text-[11px] font-semibold text-cg-amber-text">Queued</span>
            </p>
          </Appear>
        </div>
        <div className="flex items-center justify-between border-t border-cg-line bg-cg-tint px-3.5 py-2.5 text-[12px] text-cg-muted-strong">
          <span>Message the agent…</span>
          <span className="flex gap-2">
            <span className="rounded-md border border-cg-line px-2 py-0.5">Opus</span>
            <span className="rounded-md border border-cg-line px-2 py-0.5">Work account</span>
          </span>
        </div>
      </Window>
      <Appear at={170} className="absolute bottom-[38px]">
        <span className="flex items-center gap-1.5 rounded-full bg-cg-primary px-3.5 py-1.5 text-[13px] font-medium text-cg-on-primary">
          <Check aria-hidden="true" size={14} /> Same chat, any agent
        </span>
      </Appear>
    </Scene>
  );
}
