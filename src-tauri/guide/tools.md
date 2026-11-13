# The ataraxia_* tools

They belong to the Ataraxia MCP server. Writing needs write access, which a normal chat has.
When the server is scoped to this chat, `session_id` can be left out, and `checkpoint_id`
defaults to the newest checkpoint of this chat.

| Tool | Does | Needs |
| --- | --- | --- |
| `ataraxia_list_artifacts` | lists decisions runs, review priority and flows (`kind` filters) | none |
| `ataraxia_get_artifact` | reads one artifact | `artifact_id` |
| `ataraxia_list_decisions` | lists the decisions of the chat | none |
| `ataraxia_get_decision` | reads a decision and its discussion | `decision_id` |
| `ataraxia_record_decision` | opens a decision (see `decisions.md`) | `title`, `summary` |
| `ataraxia_add_decision_message` | adds a message to a decision's thread | `decision_id`, `text` |
| `ataraxia_link_commit` | says a commit influences a decision | `decision_id`, `commit` |
| `ataraxia_comment_unit` | comments on a component or a line (see `review.md`) | `text` |
| `ataraxia_set_priority` | changes or resets a component's priority | `path`, `unit` |
| `ataraxia_record_flow` | draws a diagram (see `flow.md`) | `nodes` |

## When the tools are not there

If your session has no `ataraxia_*` tools, the MCP server is not connected to this agent. Say so
in one sentence and tell the developer they can add it from Ataraxia, Settings, MCP server,
which shows the command to register. Do not try to write the artifacts some other way, and do
not edit the app's database.
