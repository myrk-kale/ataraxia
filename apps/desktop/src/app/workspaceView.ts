import type { RepoChanges } from "../lib/insights";
import type { Repository, RepositoryId, Workspace, WorkspaceSnapshot } from "../lib/workspace";

/** The selected workspace with its repositories, in the order the user arranged them. */
export function selectedWorkspace(snapshot: WorkspaceSnapshot): { workspace: Workspace; members: Repository[] } | null {
  const workspace = snapshot.workspaces.find((item) => item.id === snapshot.selected_workspace_id);
  if (!workspace) {
    return null;
  }
  const members = workspace.repository_ids
    .map((id) => snapshot.repositories.find((repository) => repository.id === id))
    .filter((repository): repository is Repository => Boolean(repository));
  return { workspace, members };
}

/**
 * Where a file a chat named lives. Paths of the chat's own repository are bare; a path of any other
 * member reads `<repository>/<path>`. A first segment that is not a member's name is part of the
 * chat's own repository, and so is a path in a workspace of one.
 */
export function resolveFileRef(
  path: string,
  ownRepositoryId: RepositoryId | null,
  members: readonly Repository[],
): { repositoryId: RepositoryId | null; path: string } {
  if (members.length > 1) {
    const slash = path.indexOf("/");
    if (slash > 0 && slash < path.length - 1) {
      const owner = members.find((item) => item.id !== ownRepositoryId && item.name === path.slice(0, slash));
      if (owner) {
        return { repositoryId: owner.id, path: path.slice(slash + 1) };
      }
    }
  }
  return { repositoryId: ownRepositoryId, path };
}

/** The text of a repository in the selector: its name, and what the agent changed there. */
export function repositoryOptionLabel(name: string, changes: RepoChanges | undefined): string {
  if (!changes || changes.files === 0) {
    return name;
  }
  const files = `${changes.files} changed`;
  return changes.unreviewed > 0 ? `${name} · ${files}, ${changes.unreviewed} unreviewed` : `${name} · ${files}`;
}

/** Unreviewed files the agent left in every repository except the one in focus. */
export function unreviewedElsewhere(changes: readonly RepoChanges[], focus: RepositoryId | null): number {
  return changes.filter((item) => item.repositoryId !== focus).reduce((sum, item) => sum + item.unreviewed, 0);
}

/** The key under which the comparison of one repository of one chat is remembered. */
export function referenceKey(chatId: string, repositoryId: RepositoryId): string {
  return `ataraxia.compareWith.${chatId}.${repositoryId}`;
}
