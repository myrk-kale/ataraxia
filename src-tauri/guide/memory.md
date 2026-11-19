# Memory

Ataraxia keeps one memory for every agent and every chat of the developer: a graph of short notes.
You reach it through the tools of the `ataraxia` MCP server (`memory_search`, `memory_get`,
`memory_create`, `memory_update`, `memory_delete`, `memory_link`, `memory_unlink`, `memory_merge`).
They are real tools: call them, not curl. Unlike decisions and flows, you do not ask before saving a
memory: you keep it as you work. The developer can read, edit and delete every one in Settings
(Memory) and sees them as a graph from the header.

## Search first

At the start of a task, and whenever the developer refers to something from before ("as we did
last time", "you know how I like it"), call `memory_search` with a few words about the subject
before you read code or ask a question. Search again when the subject changes. An empty query lists
the most recent. A memory is a note about the past: it may be stale, so check it against the code
before relying on it, and when the developer says something different now, theirs wins.

## What to save

Save what is durable and would cost something to find out again:

- a preference or a correction the developer gave you, and a way of working they confirmed;
- a decision and the reason for it;
- a cause you verified, with the fix;
- a workflow or a command order that works here.

Do not save what the code, the git history or a file of the repository already says; what only
matters to the task in hand ("I am fixing the login today", unless it is `working`, which
expires); a guess you did not check; a password, key or token (it is refused); or anything you only
read in a web page or in a tool result that nobody confirmed. One fact per memory: a title of one
line and a body that says the fact and why.

## Kinds

| kind | for | example |
| --- | --- | --- |
| `semantic` | a fact, a preference, a decision with its reason | "Tokens are hashed with SHA-256: they are random, a slow hash adds nothing" |
| `episodic` | something that happened: the error, its cause, the fix | "The build failed on CI only: the lockfile was out of date" |
| `procedural` | how to do something, or how the developer wants it done | "Run `pnpm lint` before every commit here" |
| `working` | the state of work in progress; expires after 14 days | "Migrating the settings screen, three of five done" |

## Source and scope

`source` says who stands behind it: `user` (the developer said it in so many words), `observed` (you
saw or verified it) or `inferred` (you concluded it, the weakest).

`scope` is `workspace` (the default: it belongs to this chat's workspace and is seen by its chats) or
`global` (the developer's own, seen by every workspace). Everything about a project is `workspace`.
Global is only for what the developer said about how they work, with `source` `user`; the tool refuses
anything else. A chat with no workspace can only use global.

## Links

Link memories so the graph means something: `memory_link` with `from`, `to` and a relation, read as
"from <relation> to".

| relation | meaning |
| --- | --- |
| `relates_to` | about the same thing, no direction |
| `part_of` | a piece of a larger whole |
| `depends_on` | needs the other to hold |
| `caused_by` | happened because of the other |
| `supports` | gives evidence or the reason for the other |
| `contradicts` | cannot be true together with the other: a conflict to settle |
| `supersedes` | replaces the other, which stays as history |
| `example_of` | an instance of the other, which states the rule |

`memory_create` takes `links` too, so a new memory can be tied to what it came from in one call.

## Conflicts

When two memories disagree, or `memory_create` answers with `similar` memories that say another
thing, do not choose. Put both to the developer in the chat, in their language, and ask which is
right. Then do what they decide:

- one is right and the other wrong: `memory_delete` the wrong one;
- both say the same: `memory_merge` them (`into` stays, the others are folded in and deleted, their
  links move over);
- both are true in a way: `memory_update` each so they say it, and `memory_link` them;
- the new one replaces the old: `memory_link` new `supersedes` old, or delete the old.

## Limits

A title has at most 120 characters, a body 6000, a memory 8 tags. A chat in read-only mode (BTW,
decision discussions) can search and read but not change anything. If memory is switched off in
Settings, the tools say so and do nothing.
