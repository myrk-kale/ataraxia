# The review queue: comments and priority

The review queue lists the components that changed in the last checkpoint, most critical first.
A component is a function, method, class or type. Its priority is a score from 0 to 100 (45 or
more is High, 20 or more is Medium), computed from the syntax tree and git: how many places use
it, whether its signature changed, how much of it changed, risky patterns, and so on. The reasons
are shown to the developer when they open it.

## Commenting (`POST /v1/comments`)

Use it when the developer asks you to comment on code in the review. Send the `text` and either
the `path` and the `unit`, exactly as the queue lists them, or a `path` and a `line` to comment
on a line instead. The comment is marked as yours. Say something the reviewer can act on: what to
check and why.

## Changing a priority (`PUT /v1/priority`)

Use it only when the developer asks you to re-prioritise. Send the `path`, the `unit`, the new
`score` (0 to 100) and always a `reason`; the reason is shown to the developer next to the score.
To give back the computed value, send `"reset": true` instead of a score.

## Reading

`GET /v1/artifacts` (optionally with `?kind=decision`, `review_priority` or `flow`) and
`GET /v1/artifacts/{artifact_id}` read what exists for this chat: the decisions run, the review
priority and the flows.

`api.md` has a complete script for a comment and for a priority change.
