# Decisions

A decision is a choice the reviewer should consciously accept or reject. It opens as a thread in
the Decisions tab and stays open while the code changes. The developer can discuss it, approve
it, or reopen it.

## Which ones to record

Record a choice when a reasonable reviewer could have wanted another outcome and the code
settles it: an API contract or its compatibility, data integrity, security, a new dependency,
performance trade-offs, behaviour that users will notice, how the code is organised.

Do not record: renames, formatting, obvious fixes, or anything that has no alternative. Usually
two to six decisions come out of a piece of work; sometimes none, and then say so instead of
inventing them. Call `GET /v1/decisions` first so you do not repeat one that exists.

## How to write one (`POST /v1/decisions`)

- `title`: the choice, in a short phrase ("Tokens are stored hashed, never in clear text").
- `summary`: what was chosen, in one or two sentences.
- `context`: what led to it. `rationale`: why this over the alternatives.
- `type`: `api-contract`, `data-integrity`, `behavior`, `security`, `dependencies`,
  `performance`, `code-organization`, `ux` or `other`.
- `files`: the code it is about (in a workspace of several repositories, `<repository>/<path>` outside the first one), as objects with a `path` and, where you know them,
  `start_line` and `end_line`.

Call it once per decision. Do not bundle several choices in one thread. The response is the
decision, and its `id` is what the calls below need. `api.md` has a complete script.

## After the decision exists

- A commit that settles, changes or contradicts a decision:
  `POST /v1/decisions/{decision_id}/commits` with the `commit` (an id, a short id, a branch or a
  tag) and a `note` on what it did to the decision.
- A reply to something in a thread: `POST /v1/decisions/{decision_id}/messages` with the `text`.
- To read one with its discussion: `GET /v1/decisions/{decision_id}`.
