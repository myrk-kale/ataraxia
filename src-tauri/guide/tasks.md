# The developer's tasks

Ataraxia has a task list that belongs to the developer. They jot a task down with a title, and may
add notes and mark it ready for development. Every task has a number that never changes and is never
reused. The developer names it in the chat as `#12`, `task 12` or just `12` after the word task.

This is the same for every agent (Claude, Codex, OpenCode). Read `api.md` first for the environment
variables and how to call the API.

## When to read a task

- The developer names a task by its number: fetch it, read its title and notes, and treat them as
  what they are asking for. Do not guess from the number alone.
- They ask what is ready, what is left, or what to do next: list the tasks with
  `?status=ready`, and say what you found.

## Reading

```bash
curl -sS "$ATARAXIA_API_URL/v1/tasks/12" -H "Authorization: Bearer $ATARAXIA_API_TOKEN"
curl -sS "$ATARAXIA_API_URL/v1/tasks?status=ready" -H "Authorization: Bearer $ATARAXIA_API_TOKEN"
```

A task is `{"number", "title", "notes", "status", "created_at", "updated_at"}`. `status` is:

- `draft`: a title jotted down. It may be vague. If the developer asks you to develop a draft, say
  what is unclear before you start, and ask only what you cannot decide yourself.
- `ready`: the developer said it is clear enough to be developed.
- `done`: finished. Do not work on it again unless asked.

A task that does not exist answers 404: tell the developer the number is unknown. Tasks are
read-only for you; the developer is the one who creates them and changes their status.
