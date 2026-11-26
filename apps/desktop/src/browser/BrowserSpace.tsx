import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Bug,
  Globe,
  History,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RotateCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  browserActivate,
  browserClearData,
  browserClose,
  browserDevtools,
  browserGo,
  browserNavigate,
  browserOpen,
  browserScreenshot,
  browserSetAgentControl,
  browserSetAgentsAllowed,
  browserStop,
  useAgentActivity,
  useBrowser,
  type BrowserTab,
} from "../lib/browser";
import { Button } from "../ui/Button";
import { Tip } from "../ui/Overlay";
import { BrowserHistoryPanel } from "./BrowserHistoryPanel";
import { DebugPanel } from "./DebugPanel";
import { displayAddress, START_PAGES, tabLabel } from "./model";
import { useSomethingOver, useViewport } from "./useViewport";

const HEIGHT_KEY = "ataraxia.browser.debugHeight";
const OPEN_KEY = "ataraxia.browser.debugOpen";

function readNumber(key: string, fallback: number): number {
  const value = Number(window.localStorage.getItem(key));
  return Number.isFinite(value) && value >= 140 && value <= 720 ? value : fallback;
}

function Favicon({ tab }: { tab: BrowserTab }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [tab.favicon]);
  if (tab.loading) {
    return <LoaderCircle aria-label="Loading" className="flex-none animate-spin text-cg-muted-strong" size={13} />;
  }
  if (!tab.favicon || broken || tab.url === "about:blank") {
    return <Globe aria-hidden="true" className="flex-none text-cg-muted" size={13} />;
  }
  return <img alt="" className="h-3.5 w-3.5 flex-none rounded-[3px]" src={tab.favicon} onError={() => setBroken(true)} />;
}

function TabStrip({ tabs, active, onNew }: { tabs: BrowserTab[]; active: number | null; onNew: () => void }) {
  return (
    <div aria-label="Tabs" className="flex flex-none items-center gap-1 overflow-x-auto px-2 pt-1.5" role="tablist">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <div
            key={tab.id}
            className={`group flex h-8 max-w-[220px] min-w-[110px] flex-1 items-center gap-1.5 rounded-t-cg-md border border-b-0 px-2.5 text-small ${
              selected ? "border-cg-line bg-cg-panel text-cg-ink" : "border-transparent text-cg-muted-strong hover:bg-cg-tint"
            }`}
          >
            <button
              aria-selected={selected}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              role="tab"
              title={`${tabLabel(tab)}\n${tab.url}`}
              type="button"
              onClick={() => void browserActivate(tab.id)}
            >
              <Favicon tab={tab} />
              <span className="truncate">{tabLabel(tab)}</span>
              {tab.profile === "agent" ? (
                <Bot aria-label="Opened by an agent" className="flex-none text-cg-accent" size={12} />
              ) : tab.agentControl ? (
                <Bot aria-label="Shared with agents" className="flex-none text-cg-muted-strong" size={12} />
              ) : null}
              {tab.errors + tab.failedRequests > 0 ? (
                <span aria-label={`${tab.errors} errors, ${tab.failedRequests} failed requests`} className="h-1.5 w-1.5 flex-none rounded-full bg-cg-red" />
              ) : null}
            </button>
            <button
              aria-label={`Close ${tabLabel(tab)}`}
              className="grid h-5 w-5 flex-none place-items-center rounded-cg-sm text-cg-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-cg-line hover:text-cg-ink"
              type="button"
              onClick={() => void browserClose(tab.id)}
            >
              <X aria-hidden="true" size={12} />
            </button>
          </div>
        );
      })}
      <Tip label="New tab">
        <Button aria-label="New tab" variant="icon" onClick={onNew}>
          <Plus aria-hidden="true" size={14} />
        </Button>
      </Tip>
    </div>
  );
}

function StartPage({ onGo }: { onGo: (input: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="grid h-full place-items-center overflow-auto p-8">
      <div className="w-full max-w-[560px]">
        <h2 className="text-center text-title font-semibold text-cg-ink">Browser</h2>
        <p className="mt-1 mb-5 text-center text-small text-cg-muted-strong">
          A page you can read together with your agent: it can open tabs, click, type and look at the requests the page makes, while you watch.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) onGo(text);
          }}
        >
          <label className="flex h-11 items-center gap-2 rounded-cg-lg border border-cg-line-strong bg-cg-panel px-3.5 focus-within:border-cg-ink">
            <Search aria-hidden="true" className="text-cg-muted" size={15} />
            <input
              aria-label="Search or enter an address"
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-body text-cg-ink outline-none placeholder:text-cg-muted"
              placeholder="Search or enter an address"
              spellCheck={false}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
        </form>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {START_PAGES.map((page) => (
            <Button key={page.url} size="sm" variant="quiet" onClick={() => onGo(page.url)}>
              {page.label}
            </Button>
          ))}
        </div>
        <p className="mt-6 flex items-start justify-center gap-1.5 text-center text-small text-cg-muted">
          <ShieldCheck aria-hidden="true" className="mt-0.5 flex-none" size={13} />
          Tabs an agent opens keep their own cookies and logins, apart from yours. Yours are shared with an agent only when you say so.
        </p>
      </div>
    </div>
  );
}

/** The picture of a page that is shown while something is over it, and kept fresh while it is not. */
function useSnapshot(tab: number | null, live: boolean, loading: boolean): string | null {
  const [pictures, setPictures] = useState<Record<number, string>>({});
  useEffect(() => {
    if (tab === null || !live || loading) {
      return;
    }
    let stop = false;
    const take = () => {
      browserScreenshot(tab).then(
        (png) => {
          if (!stop) setPictures((all) => ({ ...all, [tab]: `data:image/png;base64,${png}` }));
        },
        () => undefined,
      );
    };
    const first = window.setTimeout(take, 400);
    const timer = window.setInterval(take, 5000);
    return () => {
      stop = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [tab, live, loading]);
  return tab === null ? null : (pictures[tab] ?? null);
}

/**
 * The built-in browser. The pages are native views the app draws over the box in the middle of
 * this space; everything around the box (tabs, address bar, developer tools) is the interface's.
 * An agent can open tabs and drive them through its tools: it works in tabs of its own, with
 * cookies of their own, and a tab of yours is its only when you hand it over.
 */
export function BrowserSpace({
  visible,
  overlayOpen,
  workspaceId = null,
  onError,
}: {
  /** This space is the one on screen. */
  visible: boolean;
  workspaceId?: string | null;
  /** A dialog or panel of the interface is open over everything. */
  overlayOpen: boolean;
  onError: (message: string) => void;
}) {
  const { tabs, active: activeId, agentsAllowed } = useBrowser();
  const activity = useAgentActivity();
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const [debugOpen, setDebugOpen] = useState(() => window.localStorage.getItem(OPEN_KEY) === "1");
  const [debugHeight, setDebugHeight] = useState(() => readNumber(HEIGHT_KEY, 280));
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);

  function closeHistory(): void {
    setHistoryOpen(false);
    historyButton.current?.focus();
  }
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const address = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const showStart = !active || active.url === "about:blank";
  const over = useSomethingOver(visible);
  const hidden = showStart || over || overlayOpen || menuOpen || (historyOpen && !!workspaceId);
  useViewport(viewport, visible, hidden);
  const picture = useSnapshot(active?.id ?? null, visible && !hidden, active?.loading ?? false);

  useEffect(() => window.localStorage.setItem(OPEN_KEY, debugOpen ? "1" : "0"), [debugOpen]);
  useEffect(() => window.localStorage.setItem(HEIGHT_KEY, String(Math.round(debugHeight))), [debugHeight]);
  useEffect(() => {
    if (!editing) {
      setDraft(active ? displayAddress(active.url) : "");
    }
  }, [active?.url, active?.id, editing]);

  const busyHere = activity?.busy && active && activity.tab === active.id ? activity : null;

  function fail(error: unknown) {
    onError(String(error));
  }

  function go(input: string) {
    const text = input.trim();
    if (!text) return;
    if (active) {
      browserNavigate(active.id, text).catch(fail);
    } else {
      browserOpen(text).catch(fail);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    go(draft);
    setEditing(false);
    address.current?.blur();
  }

  function newTab() {
    browserOpen()
      .then(() => window.setTimeout(() => address.current?.focus(), 50))
      .catch(fail);
  }

  const shortcuts = useMemo(
    () => ({
      l: () => {
        address.current?.focus();
        address.current?.select();
      },
      r: () => active && browserGo(active.id, "reload").catch(fail),
      "[": () => active?.canGoBack && browserGo(active.id, "back").catch(fail),
      "]": () => active?.canGoForward && browserGo(active.id, "forward").catch(fail),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active?.id, active?.canGoBack, active?.canGoForward],
  );

  return (
    <div
      ref={root}
      className="flex h-full min-h-0 flex-col bg-cg-bg"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
          const action = shortcuts[event.key as keyof typeof shortcuts];
          if (action) {
            event.preventDefault();
            action();
          }
        }
      }}
    >
      <TabStrip active={activeId} tabs={tabs} onNew={newTab} />
      <div className="flex flex-none items-center gap-1.5 border-y border-cg-line bg-cg-panel px-2 py-1.5">
        <Tip label="Back (⌘[)">
          <Button aria-label="Back" disabled={!active?.canGoBack} variant="icon" onClick={() => active && browserGo(active.id, "back").catch(fail)}>
            <ArrowLeft aria-hidden="true" size={15} />
          </Button>
        </Tip>
        <Tip label="Forward (⌘])">
          <Button aria-label="Forward" disabled={!active?.canGoForward} variant="icon" onClick={() => active && browserGo(active.id, "forward").catch(fail)}>
            <ArrowRight aria-hidden="true" size={15} />
          </Button>
        </Tip>
        <Tip label={active?.loading ? "Stop" : "Reload (⌘R)"}>
          <Button
            aria-label={active?.loading ? "Stop loading" : "Reload"}
            disabled={!active || showStart}
            variant="icon"
            onClick={() => {
              if (!active) return;
              (active.loading ? browserStop(active.id) : browserGo(active.id, "reload")).catch(fail);
            }}
          >
            {active?.loading ? <X aria-hidden="true" size={15} /> : <RotateCw aria-hidden="true" size={15} />}
          </Button>
        </Tip>
        <form className="min-w-0 flex-1" onSubmit={submit}>
          <label className="flex h-8 items-center gap-2 rounded-cg-md border border-cg-line bg-cg-bg px-2.5 focus-within:border-cg-ink">
            <Search aria-hidden="true" className="flex-none text-cg-muted" size={13} />
            <input
              ref={address}
              aria-label="Address"
              className="min-w-0 flex-1 bg-transparent text-ui text-cg-ink outline-none placeholder:text-cg-muted"
              placeholder="Search or enter an address (⌘L)"
              spellCheck={false}
              value={draft}
              onBlur={() => setEditing(false)}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => {
                setEditing(true);
                event.currentTarget.select();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setEditing(false);
                  setDraft(active ? displayAddress(active.url) : "");
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
        </form>
        {active && !showStart ? (
          active.profile === "agent" ? (
            <Tip label="An agent opened this tab. It has its own cookies and logins, apart from yours.">
              <span className="flex h-8 items-center gap-1 rounded-cg-md bg-cg-accent/10 px-2 text-small font-medium text-cg-accent">
                <Bot aria-hidden="true" size={13} />
                Agent tab
              </span>
            </Tip>
          ) : (
            <Tip label={active.agentControl ? "An agent can see and act on this tab, with your cookies and logins. Click to take it back." : "Let an agent use this tab. It would see the page and be signed in as you."}>
              <Button
                aria-label="Let agents use this tab"
                aria-pressed={active.agentControl}
                disabled={!agentsAllowed}
                variant="quiet"
                onClick={() => browserSetAgentControl(active.id, !active.agentControl).catch(fail)}
              >
                <Bot aria-hidden="true" size={13} />
                {active.agentControl ? "Shared" : "Share"}
              </Button>
            </Tip>
          )
        ) : null}
        <Tip label="Workspace history">
          <Button ref={historyButton} aria-label="Browsing history" aria-expanded={historyOpen && !!workspaceId} disabled={!workspaceId} variant="icon" onClick={() => setHistoryOpen((open) => !open)}>
            <History aria-hidden="true" size={15} />
          </Button>
        </Tip>
        <Tip label="Console and network">
          <Button aria-label="Developer tools" aria-pressed={debugOpen} disabled={!active || showStart} variant="icon" onClick={() => setDebugOpen((open) => !open)}>
            <span className="relative grid place-items-center">
              <Bug aria-hidden="true" size={15} />
              {active && active.errors + active.failedRequests > 0 ? <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-cg-red" /> : null}
            </span>
          </Button>
        </Tip>
        <div className="relative">
          <Button aria-expanded={menuOpen} aria-haspopup="menu" aria-label="Browser menu" variant="icon" onClick={() => setMenuOpen((open) => !open)}>
            <MoreHorizontal aria-hidden="true" size={15} />
          </Button>
          {menuOpen ? (
            <div
              className="absolute top-9 right-0 z-30 w-[290px] rounded-cg-md border border-cg-line-strong bg-cg-float p-1 text-small shadow-cg-pop"
              role="menu"
              onKeyDown={(event) => event.key === "Escape" && setMenuOpen(false)}
            >
              <button
                aria-checked={agentsAllowed}
                className="flex w-full items-start gap-2 rounded-cg-sm px-2.5 py-2 text-left hover:bg-cg-tint"
                role="menuitemcheckbox"
                type="button"
                onClick={() => browserSetAgentsAllowed(!agentsAllowed).catch(fail)}
              >
                <span className={`mt-0.5 grid h-3.5 w-3.5 flex-none place-items-center rounded-[3px] border text-[10px] ${agentsAllowed ? "border-cg-primary bg-cg-primary text-cg-on-primary" : "border-cg-line-strong"}`}>{agentsAllowed ? "✓" : ""}</span>
                <span>
                  <span className="block font-medium text-cg-ink">Agents can use the browser</span>
                  <span className="block text-cg-muted-strong">Off: they cannot open tabs or see any.</span>
                </span>
              </button>
              <button
                className="flex w-full rounded-cg-sm px-2.5 py-2 text-left text-cg-ink hover:bg-cg-tint disabled:opacity-40"
                disabled={!active || showStart}
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  if (active) browserDevtools(active.id).catch(fail);
                }}
              >
                Open the page inspector
              </button>
              <button
                className="flex w-full rounded-cg-sm px-2.5 py-2 text-left text-cg-ink hover:bg-cg-tint"
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  browserClearData("agent").catch(fail);
                }}
              >
                Clear what agents' tabs stored
              </button>
              <button
                className="flex w-full rounded-cg-sm px-2.5 py-2 text-left text-cg-ink hover:bg-cg-tint"
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  browserClearData("user").catch(fail);
                }}
              >
                Clear my browsing data
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {busyHere ? (
        <div className="flex flex-none items-center gap-2 border-b border-cg-accent/30 bg-cg-accent/10 px-3 py-1.5 text-small text-cg-accent" role="status">
          <Bot aria-hidden="true" size={14} />
          <span className="min-w-0 flex-1 truncate">An agent is using this tab ({busyHere.action}). You can keep watching; the mouse shows where it acts.</span>
          {active ? (
            <Button size="sm" variant="quiet" onClick={() => browserSetAgentControl(active.id, false).catch(fail)}>
              Take over
            </Button>
          ) : null}
        </div>
      ) : null}
      {active?.loadError ? (
        <div className="flex-none border-b border-cg-red/30 bg-cg-red/5 px-3 py-1.5 text-small text-cg-red" role="alert">
          {active.loadError}
        </div>
      ) : null}
      <div ref={viewport} className="relative min-h-0 flex-1 bg-cg-panel" data-browser-viewport>
        {showStart ? (
          <StartPage onGo={go} />
        ) : picture ? (
          <img alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover object-top" src={picture} />
        ) : null}
        {!showStart && hidden && !picture ? <div className="absolute inset-0 grid place-items-center text-small text-cg-muted">Paused while something is open over it</div> : null}
        {historyOpen && workspaceId ? <BrowserHistoryPanel key={workspaceId} workspaceId={workspaceId} onClose={closeHistory} /> : null}
      </div>
      {debugOpen && active && !showStart ? <DebugPanel height={debugHeight} tab={active} onClose={() => setDebugOpen(false)} onResize={setDebugHeight} /> : null}
    </div>
  );
}
