import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Repository } from "../lib/workspace";
import { RepositorySelect } from "./RepositorySelect";

const repo = (id: string, name: string): Repository => ({ id, root: `/w/${name}`, name, created_at: "", updated_at: "" });
const members = [repo("r1", "app"), repo("r2", "api")];

describe("RepositorySelect", () => {
  it("lists every member, says in words what the agent changed there, and shows only the name on the trigger", () => {
    const html = renderToStaticMarkup(
      <RepositorySelect
        changes={[
          { repositoryId: "r1", files: 0, unreviewed: 0 },
          { repositoryId: "r2", files: 4, unreviewed: 3 },
        ]}
        repositories={members}
        value="r1"
        onChange={() => {}}
      />,
    );
    expect(html).toContain("api · 4 changed, 3 unreviewed");
    expect(html).toContain('aria-label="Repository"');
    // The trigger reads the name alone, the list carries the counts.
    expect(html.match(/<span class="truncate">app<\/span>/)).not.toBeNull();
  });

  it("tells, without colour, that another repository has unreviewed files", () => {
    const changes = [
      { repositoryId: "r1", files: 1, unreviewed: 1 },
      { repositoryId: "r2", files: 4, unreviewed: 3 },
    ];
    const full = renderToStaticMarkup(
      <RepositorySelect changes={changes} repositories={members} value="r1" onChange={() => {}} />,
    );
    expect(full).toContain("3 unreviewed elsewhere");
    const compact = renderToStaticMarkup(
      <RepositorySelect compact changes={changes} repositories={members} value="r1" onChange={() => {}} />,
    );
    expect(compact).toContain("+3");
    expect(compact).toContain("3 unreviewed files in the other repositories of this workspace");
  });

  it("shows nothing extra when the repository in focus is the only one with changes", () => {
    const html = renderToStaticMarkup(
      <RepositorySelect
        changes={[{ repositoryId: "r1", files: 2, unreviewed: 2 }]}
        repositories={members}
        value="r1"
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("elsewhere");
  });
});
