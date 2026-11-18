# Decisions

A decision is a choice the reviewer should consciously accept or reject. It shows in the chat as
an artifact (a Decisions row); the developer expands it in the chat and approves or rejects each
decision. A rejection always comes with the developer's comment.

When the last open decision gets its verdict, Ataraxia sends you one message that starts with
`[Decision review`: either everything was approved (nothing to change), or which decisions were
rejected and the comment on each. Act on the rejected ones: change the code as the comment asks,
or ask the developer when the comment is unclear.

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

Call it once per decision. Do not bundle several choices in one decision. The response is the
decision, and its `id` is what the calls below need. `api.md` has a complete script.

## After the decision exists

- A commit that settles, changes or contradicts a decision:
  `POST /v1/decisions/{decision_id}/commits` with the `commit` (an id, a short id, a branch or a
  tag) and a `note` on what it did to the decision.
- A note on a decision: `POST /v1/decisions/{decision_id}/messages` with the `text`.
- To read one with its comments and verdicts: `GET /v1/decisions/{decision_id}`.
