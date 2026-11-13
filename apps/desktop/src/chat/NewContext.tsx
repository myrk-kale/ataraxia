import type { ProviderDescriptor } from "../lib/agent";
import { Button } from "../ui/Button";
import { Hero } from "./Hero";

export function NewContext({
  busy,
  canCreate,
  contextLabel,
  hasRepository,
  providerLabel,
  providers,
  onNewChat,
  onOpenRepository,
}: {
  busy: boolean;
  canCreate: boolean;
  contextLabel: string | null;
  hasRepository: boolean;
  /** The provider a new chat will use; `null` when none can run. */
  providerLabel: string | null;
  /** The providers the person can pick from; `null` while they are still being detected. */
  providers: ProviderDescriptor[] | null;
  onNewChat: () => void;
  onOpenRepository: () => void;
}) {
  const detecting = hasRepository && providers === null;
  const noAgent = hasRepository && providers !== null && providerLabel === null;

  return (
    <section className="flex h-full flex-col overflow-y-auto">
      <Hero contextLabel={contextLabel}>
        <div className="mt-8 flex justify-center">
          {hasRepository ? (
            <Button disabled={!canCreate} variant="primary" onClick={onNewChat}>
              {providerLabel ? `Start a chat with ${providerLabel}` : "Start a chat"}
            </Button>
          ) : (
            <Button disabled={busy} variant="primary" onClick={onOpenRepository}>
              Open a repository
            </Button>
          )}
        </div>
        {detecting ? (
          <p className="mt-4 text-small text-cg-muted" role="status">
            Looking for a coding agent on this computer…
          </p>
        ) : noAgent ? (
          <div className="mx-auto mt-5 max-w-[440px] text-left" role="status">
            <p className="text-ui font-semibold text-cg-ink">No coding agent found</p>
            <p className="mt-1 text-small leading-5 text-cg-muted">
              Ataraxia drives an agent CLI that is already installed and signed in. Install one of these, then reopen the app.
            </p>
            <ul className="mt-3 flex flex-col gap-1.5 text-small text-cg-muted-strong">
              {(providers ?? []).map((item) => (
                <li key={item.kind}>
                  <span className="font-medium text-cg-ink">{item.display_name}</span>
                  {item.detail ? `: ${item.detail}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-4 text-small text-cg-muted">
            {hasRepository
              ? "Each chat is tied to this worktree."
              : "Pick a git repository to create chats, review code and run the terminal."}
          </p>
        )}
      </Hero>
    </section>
  );
}
