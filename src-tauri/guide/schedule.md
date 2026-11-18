# Coming back to something later

Some work waits on something else: a release that is still building, a deploy, a test run on
another machine, a retry in a few minutes. Instead of polling in a loop or asking the developer to
come back, schedule a message to yourself. Ataraxia keeps it and, when the time comes, sends it to
this chat as a new message that starts with `[Scheduled task <id>]`. You then do what it says.

This is the same for every agent (Claude, Codex, OpenCode). Do not use your own scheduling tools
(cron, wakeups, `/loop`): they are turned off, and what they would create is lost when the agent
restarts. Ataraxia's schedule survives a restart of the app, a change of agent and a crash. The
developer sees what is scheduled in the chat, under the message box, and can cancel it there.

Read `api.md` first for the environment variables and how to call the API.

## Waiting on a command you started

To wait for something you started yourself in this session (a test run, a build), a watch or a
background command of your harness is fine: you get a new turn when it ends, and the developer sees
it as "Waiting on: ..." until then. Make sure its condition can end. `pgrep -f "pytest -q"` inside
the watch matches the watch's own command line and never ends; wait on the process id, or on a line
in the output file, instead.

## Create one

```bash
curl -sS -X POST "$ATARAXIA_API_URL/v1/schedules" \
  -H "Authorization: Bearer $ATARAXIA_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{"prompt": "Check whether the release run 123 has finished, and report.", "in_minutes": 10}
JSON
```

Fields:

- `prompt` (required): what you will be told when it is time. Write it as a note to yourself with
  everything you will need, because you will not remember this conversation as it is now: what to
  check, with which command, and what to do with the result.
- `in_minutes`: wait this long, from 1 up to 10080 (7 days). Or `at`: an RFC 3339 time. Give one of
  the two.
- `every_minutes`: also run again at this interval. A recurring schedule stops by itself after 7
  days.

The answer is the schedule, with its `id`.

## Rules

- Schedule only what the developer asked for, or what they clearly expect you to follow up on
  (for example "tell me when the release is published"). Do not schedule on your own to keep busy.
- Prefer one schedule with a good `prompt` over many. A chat holds at most 20.
- When a check finds the work still not done, schedule the next check again, a little later, and
  say so in one line. When it is done, say it and do not schedule anything.
- A scheduled message waits in the queue while you are busy, and it is sent once when the agent is
  running again if the app was closed at the time. It is not repeated once per missed run.
- A recurring schedule does not pile up: if the last message of it has not been sent yet, the next
  one is skipped.

## List and cancel

```bash
curl -sS "$ATARAXIA_API_URL/v1/schedules" -H "Authorization: Bearer $ATARAXIA_API_TOKEN"
curl -sS -X DELETE "$ATARAXIA_API_URL/v1/schedules/<id or its first 8 characters>" \
  -H "Authorization: Bearer $ATARAXIA_API_TOKEN"
```

Cancel a schedule as soon as what it waits for is no longer needed.
