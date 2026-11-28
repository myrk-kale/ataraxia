import { CircleAlert, Lock } from "lucide-react";
import type { FileRow, MemberView, Toucher } from "../lib/workbench";
import { Avatar } from "./Avatar";
import { changeWord, rangesText, splitPath, tintOf, touchersInOrder } from "./model";

/** Only what several agents touch, or what one holds and another changed. */
export function sharedRows(rows: readonly FileRow[]): FileRow[] {
  return rows.filter((row) => row.severity !== "clear");
}

function cellLabel(member: MemberView, toucher: Toucher): string {
  const { word } = changeWord(toucher.change);
  const lines = rangesText(toucher.ranges);
  return [
    `${member.title} ${word} it`,
    `plus ${toucher.additions}, minus ${toucher.deletions}`,
    lines,
    toucher.clash ? "on top of another agent" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Who touches what: a row per file, a column per agent. What the agents changed is read from each
 * worktree, so it is true whether or not anybody reported it; the files several agents are on come
 * first, the ones on the same lines before the rest.
 */
export function Files({ rows, members }: { rows: readonly FileRow[]; members: readonly MemberView[] }) {
  if (rows.length === 0) {
    return (
      <p className="mx-auto max-w-[560px] px-6 py-10 text-center text-ui leading-6 text-cg-muted">
        No agent has changed a file yet. What they change is read from each worktree, so this fills in as they work.
      </p>
    );
  }
  const nameOf = (id: string) => members.find((member) => member.sessionId === id)?.title ?? "another agent";
  return (
    <div className="mx-auto w-full max-w-[980px] overflow-x-auto px-3 py-3">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Files each agent changed since it joined the workbench</caption>
        <thead>
          <tr className="border-b border-cg-line text-small text-cg-muted-strong">
            <th className="px-3 py-2 font-medium" scope="col">
              File
            </th>
            {members.map((member) => (
              <th key={member.sessionId} className="w-[56px] px-1.5 py-2 text-center font-medium" scope="col" title={member.title}>
                <span className="inline-flex items-center justify-center">
                  <Avatar name={member.title} size={24} tint={tintOf(member.sessionId, members)} />
                  <span className="sr-only">{member.title}</span>
                </span>
              </th>
            ))}
            <th className="w-[132px] px-3 py-2 font-medium" scope="col">
              State
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { dir, name } = splitPath(row.path);
            const cells = touchersInOrder(row.touchers, members);
            const clashing = row.touchers.filter((toucher) => toucher.clash);
            return (
              <tr
                key={`${row.repositoryId}:${row.path}`}
                className={`border-b border-cg-line align-top ${row.severity === "collision" ? "bg-cg-del-bg" : ""}`}
              >
                <th className="min-w-0 px-3 py-2.5 font-normal" scope="row">
                  <span className="block break-all">
                    <span className="font-mono text-small text-cg-muted">{dir}</span>
                    <span className="font-mono text-ui font-semibold text-cg-ink">{name}</span>
                  </span>
                  {row.repository ? <span className="block text-small text-cg-muted">{row.repository}</span> : null}
                  {row.severity === "collision" && !row.destructive && clashing.some((toucher) => toucher.ranges.length > 0) ? (
                    <span className="mt-0.5 block text-small text-cg-muted-strong">
                      {clashing.map((toucher) => `${nameOf(toucher.sessionId)}: ${rangesText(toucher.ranges)}`).join(" · ")}
                    </span>
                  ) : null}
                  {row.heldBy ? (
                    <span className="mt-0.5 flex items-center gap-1 text-small text-cg-muted-strong">
                      <Lock aria-hidden="true" className="flex-none" size={11} />
                      Held by {nameOf(row.heldBy)}
                    </span>
                  ) : null}
                </th>
                {members.map((member, index) => {
                  const toucher = cells[index];
                  return (
                    <td key={member.sessionId} className="px-1.5 py-2.5 text-center">
                      {toucher ? (
                        <span
                          aria-label={cellLabel(member, toucher)}
                          className={`inline-grid h-6 w-6 place-items-center rounded-cg-sm font-mono text-small font-semibold ${
                            toucher.clash ? "bg-cg-panel text-cg-del-fg ring-1 ring-cg-del-fg" : "bg-cg-tint text-cg-muted-strong"
                          }`}
                          role="img"
                          title={cellLabel(member, toucher)}
                        >
                          {changeWord(toucher.change).letter}
                        </span>
                      ) : (
                        <span aria-label={`${member.title} did not touch it`} className="text-cg-line-strong" role="img">
                          ·
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className="px-3 py-2.5">
                  {row.severity === "collision" ? (
                    <span className="inline-flex items-center gap-1 text-small font-medium text-cg-red">
                      <CircleAlert aria-hidden="true" size={12} />
                      {row.destructive ? "Cannot merge" : "Same lines"}
                    </span>
                  ) : row.generated ? (
                    <span className="text-small font-medium text-cg-muted-strong" title="A lockfile: regenerate it when the work is joined, do not merge it by hand.">
                      Lockfile
                    </span>
                  ) : row.severity === "shared" ? (
                    <span className="text-small font-medium text-cg-amber-text">{row.touchers.length > 1 ? "Shared" : "Held by another"}</span>
                  ) : (
                    <span className="text-small text-cg-muted">One agent</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
