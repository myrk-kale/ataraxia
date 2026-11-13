# Flow

A flow is a diagram, in the Flow tab, of how a piece of the code works: where a request or an
action enters, what handles it, where data goes. It is for someone who has to understand the
change, not for decoration.

## How to draw one (`ataraxia_record_flow`)

- `name`: what the diagram shows, in a few words. `summary`: one or two sentences.
- `nodes`: each has an `id`, a `label`, and optionally a `kind` and a `description`.
  - `kind` is one of `entry`, `component`, `function`, `data`, `external`, `step`.
  - `refs` lists the code behind the node: `path` and `line`.
- `edges`: `source` and `target` are node ids; `label` says what passes or why (a verb).

## What makes it hold up

- Ground every node in files that exist. A node whose file is not in the repository is shown as
  unverified, which is a mark against the diagram. Open the files before you draw.
- Six to fourteen nodes read well. If it needs more, draw the part the change touched.
- One path through the code per diagram. Several questions mean several flows.
- Labels are names from the code, not paraphrases of it.
