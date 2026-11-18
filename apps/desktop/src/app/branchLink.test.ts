import { describe, expect, it } from "vitest";
import { parseBranchInput } from "./branchLink";

function branchOf(input: string) {
  const parsed = parseBranchInput(input);
  return parsed.ok ? parsed.target : parsed.problem;
}

describe("going to a branch from what was pasted", () => {
  it("reads the branch out of an Azure DevOps link, with the repository it is in", () => {
    expect(
      branchOf("https://dev.azure.com/acme/Shop/_git/shop-api?version=GBfeature%2Fcart-total&_a=history"),
    ).toEqual({ branch: "feature/cart-total", repository: "shop-api" });
    expect(branchOf("https://acme.visualstudio.com/Shop/_git/web?path=%2Fsrc&version=GBmain")).toEqual({
      branch: "main",
      repository: "web",
    });
  });

  it("says what is wrong with an Azure link that is not a branch", () => {
    expect(branchOf("https://dev.azure.com/acme/Shop/_git/shop-api/pullrequest/4821")).toMatch(/pull request link \(#4821\)/);
    expect(branchOf("https://dev.azure.com/acme/Shop/_git/shop-api?version=GCabc123")).toMatch(/commit or a tag/);
    expect(branchOf("https://dev.azure.com/acme/Shop/_git/shop-api")).toMatch(/does not say which branch/);
  });

  it("reads GitHub and GitLab tree links, branches with slashes included", () => {
    expect(branchOf("https://github.com/acme/web/tree/fix/login-redirect")).toEqual({
      branch: "fix/login-redirect",
      repository: "web",
    });
    expect(branchOf("https://gitlab.com/acme/web/-/tree/release/2.0")).toEqual({
      branch: "release/2.0",
      repository: "web",
    });
    expect(branchOf("https://github.com/acme/web/pull/12")).toMatch(/pull request/);
    expect(branchOf("https://github.com/acme/web/tree/fix/pull")).toEqual({
      branch: "fix/pull",
      repository: "web",
    });
    expect(branchOf("https://gitlab.com/acme/tree/web/-/tree/fix%2Blogin")).toEqual({
      branch: "fix+login",
      repository: "web",
    });
  });

  it("reads Bitbucket source links without treating the file path as part of the branch", () => {
    expect(branchOf("https://bitbucket.org/acme/web/src/feature%2Fcart/src/app.ts#lines-4")).toEqual({
      branch: "feature/cart",
      repository: "web",
    });
    expect(branchOf("https://bitbucket.org/acme/web/pull-requests/12")).toMatch(/pull request/);
  });

  it.each([
    "http://github.example.com/acme/web.git#feature/cart",
    "https://gitlab.com/acme/team/web.git#refs/heads/feature%2Fcart",
    "https://dev.azure.com/acme/shop/_git/web#feature/cart",
    "git@github.com:acme/web.git#feature/cart",
    "git@ssh.dev.azure.com:v3/acme/shop/web#feature/cart",
    "ssh://git@gitlab.example.com:2222/acme/web.git#feature/cart",
    "git@bitbucket.org:acme/web.git#feature/cart",
  ])("reads the explicit branch from %s", (input) => {
    expect(branchOf(input)).toEqual({ branch: "feature/cart", repository: "web" });
  });

  it("guides users who paste a clone URL without a branch", () => {
    expect(branchOf("git@github.com:acme/web.git")).toMatch(/append #branch/i);
    expect(branchOf("https://github.com/acme/web.git")).toMatch(/append #branch/i);
    expect(branchOf("ssh:///acme/web.git#main")).toMatch(/could not be read/);
    expect(branchOf("https://github.com/acme/web/blob/main/README.md#L1")).toMatch(/does not name a branch/);
  });

  it("takes a plain name, a ref or the git command that would do it", () => {
    expect(branchOf("  feature/x ")).toEqual({ branch: "feature/x", repository: null });
    expect(branchOf("refs/heads/feature/x")).toEqual({ branch: "feature/x", repository: null });
    expect(branchOf("origin/feature/x")).toEqual({ branch: "origin/feature/x", repository: null });
    expect(branchOf("git checkout feature/x")).toEqual({ branch: "feature/x", repository: null });
    expect(branchOf("git switch -c feature/x")).toEqual({ branch: "feature/x", repository: null });
    expect(branchOf('"main"')).toEqual({ branch: "main", repository: null });
  });

  it("refuses what is not a branch", () => {
    expect(branchOf("")).toMatch(/Paste a branch link/);
    expect(branchOf("two words")).toMatch(/no spaces/);
    expect(branchOf("--force")).toMatch(/not a branch name/);
    expect(branchOf("https://example.com/")).toMatch(/does not name a branch/);
  });
});
