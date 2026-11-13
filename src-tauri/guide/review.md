# The review queue: comments and priority

The review queue lists the components that changed in the last checkpoint, most critical first.
A component is a function, method, class or type. Its priority is a score from 0 to 100 (45 or
more is High, 20 or more is Medium), computed from the syntax tree and git: how many places use
it, whether its signature changed, how much of it changed, risky patterns, and so on. The reasons
are shown to the developer when they open it.

## Commenting (`ataraxia_comment_unit`)

Use it when the developer asks you to comment on code in the review. Give the `path` and the
`unit` exactly as the queue lists them, or a `line` to comment on a line instead, and the `text`.
The comment is marked as yours. Say something the reviewer can act on: what to check and why.

## Changing a priority (`ataraxia_set_priority`)

Use it only when the developer asks you to re-prioritise. Give the `path`, the `unit`, the new
`score` and always a `reason`; the reason is shown to the developer next to the score. To give
back the computed value, pass `reset: true` instead of a score.

## Reading

`ataraxia_list_artifacts` and `ataraxia_get_artifact` read what exists for this chat: the
decisions run, the review priority and the flows.
