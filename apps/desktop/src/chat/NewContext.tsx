import { Button } from "../ui/Button";
import { Hero } from "./Hero";

export function NewContext({
  busy,
  canCreate,
  contextLabel,
  hasRepository,
  providerLabel,
  onNewChat,
  onOpenRepository,
}: {
  busy: boolean;
  canCreate: boolean;
  contextLabel: string | null;
  hasRepository: boolean;
  providerLabel: string;
  onNewChat: () => void;
  onOpenRepository: () => void;
}) {
  return (
    <section className="cg-page-in flex h-full flex-col overflow-y-auto">
      <Hero contextLabel={contextLabel}>
        <div className="mt-8 flex justify-center">
          {hasRepository ? (
            <Button disabled={!canCreate} variant="primary" onClick={onNewChat}>
              Start a chat with {providerLabel}
            </Button>
          ) : (
            <Button disabled={busy} variant="primary" onClick={onOpenRepository}>
              Open a repository
            </Button>
          )}
        </div>
        <p className="mt-4 text-small text-cg-muted">
          {hasRepository
            ? "Each chat is tied to this worktree."
            : "Pick a git repository to create chats, review code and run the terminal."}
        </p>
      </Hero>
    </section>
  );
}
