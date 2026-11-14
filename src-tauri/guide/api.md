# The Ataraxia API

Ataraxia serves a plain HTTP API on `127.0.0.1`, on a port the system picks when the app starts.
You call it from bash with curl.

## Environment

Every agent process of this chat has three variables:

- `ATARAXIA_API_URL`: the base URL, for example `http://127.0.0.1:51234`.
- `ATARAXIA_API_TOKEN`: the bearer token. It belongs to this one chat, so requests never carry a
  session id. It is read-write in a normal chat and read-only in a hidden investigation session,
  where every write answers 403.
- `ATARAXIA_SESSION_ID`: the id of this chat. You do not need to send it.

Send the token as `Authorization: Bearer $ATARAXIA_API_TOKEN`. Never print it, echo it, write it
into a file, or put it in a message to the developer.

If `ATARAXIA_API_URL` or `ATARAXIA_API_TOKEN` is empty or unset (the app is not running, or the
agent was started outside it), tell the developer in one sentence and stop. Do not look for the
database, do not start a server of your own, and do not try another way to write the artifacts.

## How to call it

Write a small bash script, run it, and read what it prints. Keep it in a temporary file
(`mktemp`) or run it inline, and delete it afterwards. Never save it in the repository and never
commit it.

- Send JSON bodies with `Content-Type: application/json`. Write the body in a heredoc with a
  quoted delimiter (`<<'JSON'`), so backticks, `$` and quotes in your text reach the server
  untouched. Escape double quotes and backslashes inside JSON strings, and write line breaks as
  `\n`.
- Check the HTTP status with `curl -sS -w '%{http_code}'` and print the response, so you see
  what the server said. `jq` is optional; the scripts below do not need it.
- Bodies are limited to 1 MiB.

## Several repositories

When the preamble of the chat lists more than one repository, the chat belongs to a workspace and
you can read and change all of them. Write a file you name to Ataraxia (the `files` of a decision,
the `refs` of a flow node) as the path inside the first repository, the one you started in, and as
`<repository>/<path>` for any other, with the repository name the preamble gives. Ataraxia opens
the file in the right repository. A path outside every repository is shown as unverified.

## Endpoints

Paths start with `/v1`. A body field marked (required) must be present; the others can be left
out. `{...}` in a path is an id taken from an earlier response.

| Method and path | Needs write | What it does |
| --- | --- | --- |
| `GET /v1` | no | the index of endpoints |
| `GET /v1/artifacts` | no | artifacts of this chat; `?kind=decision`, `review_priority` or `flow` filters |
| `GET /v1/artifacts/{artifact_id}` | no | one artifact with its content and provenance |
| `GET /v1/decisions` | no | the decisions of this chat |
| `GET /v1/decisions/{decision_id}` | no | a decision with its discussion |
| `POST /v1/decisions` | yes | opens a decision |
| `POST /v1/decisions/{decision_id}/messages` | yes | adds a message to a decision's thread |
| `POST /v1/decisions/{decision_id}/commits` | yes | says a commit influences a decision |
| `POST /v1/comments` | yes | comments on a component or a line |
| `PUT /v1/priority` | yes | changes or resets a component's priority |
| `POST /v1/flows` | yes | draws a diagram |

`GET /v1` answers `{"version":1,"endpoints":[{"method":"GET","path":"/v1/decisions","description":"...","write":false}]}`.
When in doubt about what exists, read it.

The example responses below show the shape; ids and texts are made up, and a response can carry
more fields than shown.

### POST /v1/decisions

Opens a decision as a thread in the Decisions tab. See `decisions.md` for what to record.

| Field | Type | |
| --- | --- | --- |
| `title` | string | required |
| `summary` | string | required |
| `type` | string | `api-contract`, `data-integrity`, `behavior`, `security`, `dependencies`, `performance`, `code-organization`, `ux` or `other` |
| `context` | string | what led to the choice |
| `rationale` | string | why this over the alternatives |
| `files` | array | objects `{"path": string (required), "start_line": integer, "end_line": integer}` |
| `checkpoint_id` | string | defaults to the newest checkpoint of this chat |

Answers 201 with the decision:

```json
{"id":"6f1c1c0e-8d1e-4a43-9e0b-2f5a3f0c9a11","title":"Tokens are stored hashed","state":"pending","opened_by":"agent"}
```

A decision is about the conversation, not about a diff: it is recorded whether or not the chat has changed any code. The review endpoints below are different, because they work on the review queue of a change, and answer 400 when the chat has changed nothing yet.

### POST /v1/decisions/{decision_id}/messages

Body: `{"text": string}` (required). Answers 201 with the message.

### POST /v1/decisions/{decision_id}/commits

| Field | Type | |
| --- | --- | --- |
| `commit` | string | required: a commit id, a short id, a branch or a tag of this chat's repository |
| `note` | string | what the commit did to the decision |

Answers 201 with the link: the commit's `rev`, `short`, `subject` and your `note`. A commit that
does not exist answers 404.

### POST /v1/comments

Comments on a component of the review queue, or on a line of a file. The comment is marked as
yours.

| Field | Type | |
| --- | --- | --- |
| `text` | string | required |
| `path` | string | the file, as the review queue lists it |
| `unit` | string | the component name, as the queue lists it; leave it out to comment on a line |
| `line` | integer | the line to comment on, when there is no `unit` |
| `checkpoint_id` | string | defaults to the newest checkpoint of this chat |

Answers 201:

```json
{"done":"Commented on parse_token"}
```

### PUT /v1/priority

Moves a component in the review queue, or puts it back.

| Field | Type | |
| --- | --- | --- |
| `path` | string | required, as the queue lists it |
| `unit` | string | required, as the queue lists it |
| `score` | integer | 0 to 100; 45 or more is High, 20 or more Medium. Required unless `reset` is true |
| `reason` | string | always give one: the developer sees it next to the score |
| `reset` | boolean | `true` restores the computed priority |
| `checkpoint_id` | string | defaults to the newest checkpoint of this chat |

Answers 200:

```json
{"done":"Set the priority of parse_token to 80"}
```

### POST /v1/flows

Draws a diagram in the Flow tab. See `flow.md` for how to make it hold up.

| Field | Type | |
| --- | --- | --- |
| `nodes` | array | required, at least one: `{"id": string, "label": string}` (both required), plus `kind`, `description` and `refs` |
| `nodes[].kind` | string | `entry`, `component`, `function`, `data`, `external` or `step` |
| `nodes[].refs` | array | `{"path": string, "line": integer}`, the code behind the node |
| `edges` | array | `{"source": node id, "target": node id, "label": string}`; `source` and `target` required |
| `name` | string | what the diagram shows, in a few words |
| `summary` | string | one or two sentences |
| `checkpoint_id` | string | rarely needed; a diagram needs no code changes in the chat |

Answers 201:

```json
{"done":"Drew a diagram with 3 nodes","artifact_id":"0b9f3a52-5c0e-4c43-8d77-1b6f4f1e2a90"}
```

### Reads

`GET` endpoints answer 200 with JSON. An id that does not exist answers 404, and one that belongs
to another chat answers 403. A list of decisions looks like `[{"id":"...","title":"...","state":"pending"}]`.

## Errors

Anything that is not a success has this body, and an HTTP status that matches the code:

```json
{"error":{"code":"invalid","message":"title and summary are required"}}
```

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid` | 400 | a field is missing, malformed or out of range; the message says which |
| `unauthorized` | 401 | the token is missing or wrong |
| `forbidden` | 403 | the token is read-only and the call writes, or the id belongs to another chat |
| `not_found` | 404 | the id or the path does not exist |
| `method_not_allowed` | 405 | the path exists but not with that method |
| `too_large` | 413 | the body is over 1 MiB |
| `internal` | 500 or 503 | the server failed, or it is busy (503: wait a moment and try once more); do not retry in a loop |

On an error, read the message, fix the request once, and try again. If it still fails, tell the
developer what the server said instead of working around it. Do not repeat a write that answered
2xx: it would create a second copy.

## Reading

Reads need no body. Print the status and the response the same way:

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $ATARAXIA_API_TOKEN" \
  "$ATARAXIA_API_URL/v1/decisions"
```

## Examples

Each one is a complete script. They share the `call` function: it sends a request, prints the
status and the body, and fails on anything but 2xx. Change the texts and paths to the real ones.

### A decision

```bash
#!/usr/bin/env bash
set -eu
: "${ATARAXIA_API_URL:?not set}" "${ATARAXIA_API_TOKEN:?not set}"

call() { # call METHOD PATH, with the JSON body on stdin
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' -X "$1" "$ATARAXIA_API_URL$2" \
    -H "Authorization: Bearer $ATARAXIA_API_TOKEN" \
    -H 'Content-Type: application/json' --data-binary @-)"
  echo "HTTP $code"; cat "$out"; echo; rm -f "$out"
  case "$code" in 2*) ;; *) return 1 ;; esac
}

call POST /v1/decisions <<'JSON'
{
  "title": "Tokens are stored hashed, never in clear text",
  "summary": "Session tokens are hashed with SHA-256 before they are written to the database.",
  "type": "security",
  "context": "A leaked database file must not give out working tokens.",
  "rationale": "The tokens are random and long, so a fast hash is enough and avoids a slow login path.",
  "files": [{"path": "src/auth/tokens.rs", "start_line": 12, "end_line": 40}]
}
JSON
```

Read the `id` in the response; the next two scripts need it.

### A message on a decision

```bash
#!/usr/bin/env bash
set -eu
: "${ATARAXIA_API_URL:?not set}" "${ATARAXIA_API_TOKEN:?not set}"
id="${1:?decision id}"

call() { # call METHOD PATH, with the JSON body on stdin
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' -X "$1" "$ATARAXIA_API_URL$2" \
    -H "Authorization: Bearer $ATARAXIA_API_TOKEN" \
    -H 'Content-Type: application/json' --data-binary @-)"
  echo "HTTP $code"; cat "$out"; echo; rm -f "$out"
  case "$code" in 2*) ;; *) return 1 ;; esac
}

call POST "/v1/decisions/$id/messages" <<'JSON'
{"text": "Tokens older than 30 days are now rejected, which this decision did not cover."}
JSON
```

### Linking a commit to a decision

Run it as `bash script.sh <decision id>` after committing work that settles, changes or
contradicts the decision.

```bash
#!/usr/bin/env bash
set -eu
: "${ATARAXIA_API_URL:?not set}" "${ATARAXIA_API_TOKEN:?not set}"
id="${1:?decision id}"

call() { # call METHOD PATH, with the JSON body on stdin
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' -X "$1" "$ATARAXIA_API_URL$2" \
    -H "Authorization: Bearer $ATARAXIA_API_TOKEN" \
    -H 'Content-Type: application/json' --data-binary @-)"
  echo "HTTP $code"; cat "$out"; echo; rm -f "$out"
  case "$code" in 2*) ;; *) return 1 ;; esac
}

call POST "/v1/decisions/$id/commits" <<JSON
{"commit": "$(git rev-parse HEAD)", "note": "Implements the decision: tokens are hashed before they are stored."}
JSON
```

This heredoc is not quoted on purpose, so the shell fills in the commit id. Use it only for
values you produced yourself, never for free text.

### A flow

The paths and lines must be files that exist, or the nodes are shown as unverified.

```bash
#!/usr/bin/env bash
set -eu
: "${ATARAXIA_API_URL:?not set}" "${ATARAXIA_API_TOKEN:?not set}"

call() { # call METHOD PATH, with the JSON body on stdin
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' -X "$1" "$ATARAXIA_API_URL$2" \
    -H "Authorization: Bearer $ATARAXIA_API_TOKEN" \
    -H 'Content-Type: application/json' --data-binary @-)"
  echo "HTTP $code"; cat "$out"; echo; rm -f "$out"
  case "$code" in 2*) ;; *) return 1 ;; esac
}

call POST /v1/flows <<'JSON'
{
  "name": "Login request",
  "summary": "How a login request becomes a stored session.",
  "nodes": [
    {"id": "route", "label": "POST /login", "kind": "entry",
     "description": "Receives the credentials.",
     "refs": [{"path": "src/routes/login.rs", "line": 8}]},
    {"id": "verify", "label": "verify_password", "kind": "function",
     "refs": [{"path": "src/auth/password.rs", "line": 21}]},
    {"id": "sessions", "label": "sessions table", "kind": "data",
     "refs": [{"path": "src/db/sessions.rs", "line": 5}]}
  ],
  "edges": [
    {"source": "route", "target": "verify", "label": "checks"},
    {"source": "verify", "target": "sessions", "label": "stores the session"}
  ]
}
JSON
```

### A review comment

On a component:

```bash
#!/usr/bin/env bash
set -eu
: "${ATARAXIA_API_URL:?not set}" "${ATARAXIA_API_TOKEN:?not set}"

call() { # call METHOD PATH, with the JSON body on stdin
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' -X "$1" "$ATARAXIA_API_URL$2" \
    -H "Authorization: Bearer $ATARAXIA_API_TOKEN" \
    -H 'Content-Type: application/json' --data-binary @-)"
  echo "HTTP $code"; cat "$out"; echo; rm -f "$out"
  case "$code" in 2*) ;; *) return 1 ;; esac
}

call POST /v1/comments <<'JSON'
{
  "path": "src/auth/tokens.rs",
  "unit": "hash_token",
  "text": "Check that an empty token is rejected before it is hashed; the caller does not do it."
}
JSON
```

To comment on a line instead, send `path`, `line` and `text` without `unit`.

### A priority change

```bash
#!/usr/bin/env bash
set -eu
: "${ATARAXIA_API_URL:?not set}" "${ATARAXIA_API_TOKEN:?not set}"

call() { # call METHOD PATH, with the JSON body on stdin
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' -X "$1" "$ATARAXIA_API_URL$2" \
    -H "Authorization: Bearer $ATARAXIA_API_TOKEN" \
    -H 'Content-Type: application/json' --data-binary @-)"
  echo "HTTP $code"; cat "$out"; echo; rm -f "$out"
  case "$code" in 2*) ;; *) return 1 ;; esac
}

call PUT /v1/priority <<'JSON'
{
  "path": "src/auth/tokens.rs",
  "unit": "hash_token",
  "score": 80,
  "reason": "It guards every login and its output format changed."
}
JSON
```

To give back the computed value, send `{"path": "...", "unit": "...", "reset": true}`.
