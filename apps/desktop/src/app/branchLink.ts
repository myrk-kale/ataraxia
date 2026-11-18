/** What a pasted link or name says about the branch to go to. */
export type BranchTarget = {
  /** The branch as git knows it (`feature/x`, or `origin/feature/x`). */
  branch: string;
  /** The repository the link names, when it names one: a member of the workspace to switch. */
  repository: string | null;
};

export type BranchParse = { ok: true; target: BranchTarget } | { ok: false; problem: string };

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function fail(problem: string): BranchParse {
  return { ok: false, problem };
}

function found(branch: string, repository: string | null): BranchParse {
  const clean = branch
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "");
  if (!clean || /\s/.test(clean) || clean.startsWith("-")) {
    return fail("That is not a branch name.");
  }
  return { ok: true, target: { branch: clean, repository: repository ? decode(repository) : null } };
}

/** Azure DevOps: `https://dev.azure.com/org/project/_git/repo?version=GBfeature%2Fx`. */
function fromAzure(url: URL): BranchParse | null {
  const azure = url.hostname === "dev.azure.com" || url.hostname.endsWith(".visualstudio.com");
  if (!azure) {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const git = parts.indexOf("_git");
  const repository = git >= 0 ? (parts[git + 1] ?? null) : null;
  if (git >= 0 && parts[git + 2] === "pullrequest") {
    return fail(
      `That is a pull request link (#${parts[git + 3] ?? "?"}). Paste the link of its source branch, or the branch name.`,
    );
  }
  const version = url.searchParams.get("version");
  if (version) {
    if (version.startsWith("GB")) {
      return found(version.slice(2), repository);
    }
    return fail("That link points at a commit or a tag, not a branch.");
  }
  if (repository && parts.length === git + 2 && url.hash) {
    return fromClone(url);
  }
  return fail("That link does not say which branch. Copy a branch link or append #branch to the repository URL.");
}

function fromClone(url: URL): BranchParse {
  const repository = url.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/, "");
  if (!repository) {
    return fail("That link does not name a repository.");
  }
  if (!url.hash) {
    return fail("That link does not name a branch. Append #branch to the repository URL.");
  }
  return found(decode(url.hash.slice(1)), repository);
}

/** GitHub and GitLab tree links and Bitbucket Cloud source links. */
function fromWeb(url: URL): BranchParse {
  const azure = fromAzure(url);
  if (azure) {
    return azure;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const separator = url.hostname === "github.com" || url.hostname === "bitbucket.org" ? -1 : parts.indexOf("-", 2);
  const actionIndex = separator === -1 ? 2 : separator + 1;
  const action = parts[actionIndex];
  const repository = parts[separator === -1 ? 1 : separator - 1] ?? null;
  if (action === "pull" || action === "pulls" || action === "merge_requests" || action === "pull-requests") {
    return fail("That is a pull request link. Paste the link of its source branch, or the branch name.");
  }
  if (action === "tree" && parts.length > actionIndex + 1) {
    return found(decode(parts.slice(actionIndex + 1).join("/")), repository);
  }
  if (url.hostname === "bitbucket.org" && parts[2] === "src" && parts[3]) {
    return found(decode(parts[3]), parts[1] ?? null);
  }
  if (parts.length === 2 || parts.at(-1)?.endsWith(".git") || (parts.length === 1 && url.hash)) {
    return fromClone(url);
  }
  return fail("That link does not name a branch.");
}

/** Read a web branch link, a repository URL with #branch, or a Git branch expression. */
export function parseBranchInput(input: string): BranchParse {
  const text = input.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!text) {
    return fail("Paste a branch link or type a branch name.");
  }
  // Git also accepts the SCP-style SSH address git@host:owner/repo.git.
  const scp = /^((?:[^@\s/:]+@)?[^@\s/:]+):((?!\/\/)\S+)$/.exec(text);
  const address = /^(?:https?|ssh):\/\//i.test(text)
    ? text
    : scp && !/^(?:https?|ssh):/i.test(text)
      ? `ssh://${scp[1]}/${scp[2]}`
      : null;
  if (address) {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return fail("That link could not be read.");
    }
    if (!url.hostname) {
      return fail("That link could not be read.");
    }
    return url.protocol === "ssh:" ? fromClone(url) : fromWeb(url);
  }
  if (/^(?:https?|ssh):/i.test(text) || text.includes("://") || /^[^\s/]+@[^/\s]+:/.test(text)) {
    return fail("That link could not be read.");
  }
  const command = /^git\s+(?:checkout|switch)\s+(?:-[a-zA-Z]+\s+)*(\S+)$/.exec(text);
  const name = command ? command[1] : text;
  if (/\s/.test(name)) {
    return fail("A branch name has no spaces.");
  }
  return found(name, null);
}
