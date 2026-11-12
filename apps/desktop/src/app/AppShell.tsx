import { Button } from "@heroui/react";
import { Moon, Sun, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTypingTarget, nextSpace, SPACES, type SpaceId } from "./spaces";
import { useThemeMode } from "./theme";

function SpacePlaceholder({ spaceId }: { spaceId: SpaceId }) {
  const space = SPACES.find((item) => item.id === spaceId)!;
  return (
    <section className="flex h-full flex-col justify-center gap-3 px-10">
      <p className="text-sm uppercase tracking-[0.18em] text-foreground/50">
        {space.label}
      </p>
      <h1 className="max-w-2xl text-3xl font-medium tracking-tight text-foreground">
        {space.blurb}
      </h1>
      <p className="max-w-xl text-sm leading-6 text-foreground/60">
        Placeholder do espaço. A navegação e o chrome já seguem a SPEC; o conteúdo
        chega nas próximas PRs.
      </p>
    </section>
  );
}

export function AppShell() {
  const [space, setSpace] = useState<SpaceId>("chat");
  const [coreStatus, setCoreStatus] = useState("checking…");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const { theme, toggleTheme } = useThemeMode();

  useEffect(() => {
    let cancelled = false;
    invoke<string>("core_status")
      .then((status) => {
        if (!cancelled) {
          setCoreStatus(status);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCoreStatus(
            error instanceof Error ? error.message : "core unavailable",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }
      if (event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        setSpace((current) => nextSpace(current, -1));
      }
      if (event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        setSpace((current) => nextSpace(current, 1));
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        (event.key === "j" || event.key === "`")
      ) {
        event.preventDefault();
        setTerminalOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const active = useMemo(
    () => SPACES.find((item) => item.id === space)!,
    [space],
  );

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex h-12 items-center gap-3 border-b border-foreground/10 px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium tracking-tight">
            Concierge
          </div>
          <div className="truncate text-xs text-foreground/50">{coreStatus}</div>
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <Button size="sm" variant="ghost">
            repository
          </Button>
          <Button size="sm" variant="ghost">
            worktree
          </Button>
          <Button size="sm" variant="secondary">
            New chat
          </Button>
          <Button size="sm" variant="ghost">
            Sessions
          </Button>
        </div>

        <div className="flex items-center gap-1">
          <Button
            isIconOnly
            aria-label="Toggle terminal"
            size="sm"
            variant={terminalOpen ? "secondary" : "ghost"}
            onPress={() => setTerminalOpen((open) => !open)}
          >
            <TerminalSquare size={16} />
          </Button>
          <Button
            isIconOnly
            aria-label="Toggle theme"
            size="sm"
            variant="ghost"
            onPress={toggleTheme}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <SpacePlaceholder spaceId={space} />

        <nav
          aria-label="Spaces"
          className="absolute top-1/2 right-3 flex -translate-y-1/2 flex-col gap-2"
        >
          {SPACES.map((item) => {
            const selected = item.id === space;
            return (
              <button
                key={item.id}
                aria-current={selected ? "page" : undefined}
                aria-label={item.label}
                className={
                  selected
                    ? "h-2.5 w-2.5 rounded-full bg-foreground"
                    : "h-2.5 w-2.5 rounded-full bg-foreground/25 hover:bg-foreground/50"
                }
                title={item.label}
                type="button"
                onClick={() => setSpace(item.id)}
              />
            );
          })}
        </nav>
      </div>

      {terminalOpen ? (
        <section className="h-40 border-t border-foreground/10 bg-foreground/[0.03] px-4 py-3">
          <div className="text-xs uppercase tracking-[0.16em] text-foreground/45">
            Terminal
          </div>
          <p className="mt-2 text-sm text-foreground/65">
            Painel retrátil pronto. O PTY real entra na PR3. Espaço ativo:{" "}
            {active.label}.
          </p>
        </section>
      ) : null}
    </div>
  );
}
