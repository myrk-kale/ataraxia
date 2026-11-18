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
    return decodeURIComponent(text.replace(/\+/g, "%20"));
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
  const pull = parts.indexOf("pullrequest");
  if (pull >= 0) {
    return fail(
      `That is a pull request link (#${parts[pull + 1] ?? "?"}). Paste the link of its source branch, or the branch name.`,
    );
  }
  const version = url.searchParams.get("version");
  if (version) {
    if (version.startsWith("GB")) {
      return found(version.slice(2), repository);
    }
    return fail("That link points at a commit or a tag, not a branch.");
  }
  // A branch picked in the branches page can also sit in the path: `_git/repo/branches?...&version=`.
  return fail("That link does not say which branch. Open the branch in Azure DevOps and copy its link.");
}

/** GitHub and GitLab: `…/tree/feature/x`, `…/-/tree/feature/x`. */
function fromForge(url: URL): BranchParse | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.includes("pull") || parts.includes("pulls") || parts.includes("merge_requests")) {
    return fail("That is a pull request link. Paste the link of its source branch, or the branch name.");
  }
  const tree = parts.indexOf("tree");
  if (tree >= 0 && parts.length > tree + 1) {
    const repository = parts[tree - 1] === "-" ? parts[tree - 2] : parts[tree - 1];
    return found(decode(parts.slice(tree + 1).join("/")), repository ?? null);
  }
  return null;
}

/**
 * Reads what a person pasted to switch branch: an Azure DevOps link (or a GitHub or GitLab one), a
 * branch name, a ref (`refs/heads/x`, `origin/x`), or the git command that does it
 * (`git checkout x`, `git switch x`).
 */
export function parseBranchInput(input: string): BranchParse {
  const text = input.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!text) {
    return fail("Paste a branch link or type a branch name.");
  }
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return fail("That link could not be read.");
    }
    return fromAzure(url) ?? fromForge(url) ?? fail("That link does not name a branch.");
  }
  const command = /^git\s+(?:checkout|switch)\s+(?:-[a-zA-Z]+\s+)*(\S+)$/.exec(text);
  const name = command ? command[1] : text;
  if (/\s/.test(name)) {
    return fail("A branch name has no spaces.");
  }
  return found(name, null);
}
