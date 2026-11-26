# Showing a file in the chat, and letting the developer download it

When you make a file the developer should look at or keep (a PDF report, an HTML page, a chart, a
screenshot, a CSV, a zip), put it on Ataraxia's local file server. You get an address back. The chat
shows the file right there, in an `<object>`, and gives the developer a download button. Do not
start a server of your own for this: the one in Ataraxia is already running, only reachable from
this machine, and cleans up after itself.

This is the same for every agent (Claude, Codex, OpenCode, Cursor). Read `api.md` first for the
environment variables and how to call the API.

## When it earns its place

Share a file when seeing or saving it is the point: a generated document, an HTML preview of what
you built, an image, a data export. Do not share source files the developer already has open in
the editor, nor anything you only read. Do not share a file just because you can.

## What may be shared

Only a file inside this chat's own folders (its working directory and the other repositories of its
workspace), as it is on disk when it is asked for. These are refused with 403: a file outside
those folders, a path that leads out through a link, anything that looks like a secret (`.env`,
keys, credentials, `.npmrc`...) and anything in `.git`. A folder is refused with 400. Write the file
into the project first (a `tmp/` or `out/` folder you will not commit is a good place), then share it.

A read-only session (a BTW question) cannot share files: the call answers 403.

## How

```bash
curl -sS -X POST "$ATARAXIA_API_URL/v1/shares" \
  -H "Authorization: Bearer $ATARAXIA_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"path": "out/report.pdf", "name": "Q3 report.pdf"}'
```

- `path` (required): absolute, or relative to the chat's working directory.
- `name` (optional): the name the file is saved under. It defaults to the file's own name, and
  its extension decides the type the chat shows it as.

The answer, with status 201:

```json
{
  "id": "…", "name": "Q3 report.pdf", "mime": "application/pdf", "size": 48213,
  "url": "http://127.0.0.1:51234/f/<id>/Q3%20report.pdf",
  "download_url": "http://127.0.0.1:51234/f/<id>/Q3%20report.pdf?download=1",
  "markdown": "```object\n{\"url\":\"…\",\"title\":\"Q3 report.pdf\",\"type\":\"application/pdf\"}\n```"
}
```

Put the `markdown` value in your reply, as it is, on its own lines. The chat turns that block into
the file shown in an `<object>` with a download button under it, and a plain link if the file
cannot be shown there. You can add `"height": 600` (200 to 900) inside the JSON of the block for a
taller view. Say in a sentence what the file is: the block is not a substitute for words.

Sharing the same file under the same name again returns the same address. The file is read when it
is asked for, so if you change it, the chat shows the new content after a reload; there is no need
to share it again. Share it again, with another `name`, only to hand over a second copy.

## What shows well

| Kind | Shown in the chat |
|---|---|
| PDF, PNG, JPEG, GIF, WebP, SVG | yes |
| HTML | yes, but sandboxed: scripts do not run, nothing is fetched, forms do not work. Make it static. |
| Video and audio (MP4, WebM, MP3, WAV) | yes, and they can be seeked |
| JSON, CSV, text, Markdown, zip, anything else | download only (the chat offers a link) |

## Stopping an offer

```bash
curl -sS -X DELETE "$ATARAXIA_API_URL/v1/shares/<id>" -H "Authorization: Bearer $ATARAXIA_API_TOKEN"
```

Answers `{"unshared": true}`, or 404 if that file is not shared. You rarely need it: every offer
ends when Ataraxia is closed, and a reply that was written before that shows a file that can no
longer be opened, with a note saying so.

## Things to know

- The address contains a long random id; whoever has the address can read that file while Ataraxia
  runs, so do not paste it anywhere but the chat.
- At most 200 files are on offer at once; the oldest goes when another comes.
- The server only answers `GET` and `HEAD` from this machine.
