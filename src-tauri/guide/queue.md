# Holding the developer's message queue

The developer often queues messages while you work. Ataraxia sends them one after another as each
of your turns ends. That is fine while things go well. When you could not do something you were
asked to, the next queued message would land on top of an unfinished or broken state. Pause the
queue so it waits for the developer instead.

This is the same for every agent (Claude, Codex, OpenCode). Read `api.md` first for the
environment variables and how to call the API.

## When to pause

Pause when, at the end of your turn, something the developer asked for is left undone and they have
to act or decide before more work makes sense:

- a step failed and you could not fix it (tests that still fail, a build that does not compile, a
  command that is refused);
- you are blocked on something only they can give (a credential, a file, a decision, access);
- you stopped to ask a question without which the rest of the task would be a guess;
- part of the task was impossible or turned out different from what was asked.

Do not pause when the work is done, when you only have a suggestion or a follow-up idea, or when you
finished and merely mention a caveat. Do not pause on your own to keep a conversation going.

## How

Call it before you end your turn, then say plainly in your reply what is pending and why.

```bash
curl -sS -X POST "$ATARAXIA_API_URL/v1/queue/pause" \
  -H "Authorization: Bearer $ATARAXIA_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{"reason": "The migration fails on the users table and I need a decision on how to handle nulls."}
JSON
```

- `reason` (optional): one short sentence of what is pending. The developer sees it above the
  queue.

The answer is `{"paused": true, "queued": <how many messages wait>}`.

## What happens

The queue is held when your turn ends, not at once, so you finish your reply first. The queued
messages stay where they are. The developer sees that the queue is paused, with your reason, and
carries on by sending a message of their own or pressing "Send now" on a queued one. Calling it
twice is harmless.

Hidden investigation sessions are read-only and answer 403: do not call it there.
