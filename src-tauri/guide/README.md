# Ataraxia, for the agent working in this chat

This chat runs inside Ataraxia, an app where the developer reviews the code you write. Besides the
chat, the developer has three places that you can fill, and that this guide explains:

- The review queue lists the components (functions, classes, types) that changed, ranked by
  priority from 0 to 100. The ranking is computed locally from the syntax tree and git.
- Decisions are choices in the code that deserve the developer's verdict, each kept as a thread.
- Flow holds diagrams of how the code works, every node tied to real files.

You act on all three through a small HTTP API that Ataraxia serves on localhost. You call it from
bash with curl, as `api.md` explains. There are no tools to look for and no other way in.

## When to read this

Only after the developer says yes to your closing question, or asks you for decisions, a flow,
review comments or a priority change. Do not read it before, and do not read all of it: read this
page, then only the topic you need, and always `api.md` before the first call. The exception is
`schedule.md`, `tasks.md` and `svg.md`: read them when you need to come back to something later,
the developer names a task, or you are about to draw an SVG, even if nobody asked for decisions or
a flow.

## Topics

- `decisions.md`: what a decision is, which ones are worth recording, and how.
- `flow.md`: how to draw a diagram that holds up.
- `svg.md`: how to draw a picture (a concept map, a mind map, an architecture sketch) in a ```svg
  block of your reply, which the chat shows as an image. Read it before your first drawing in a
  chat, without waiting for a yes to anything: it is not an artifact, only part of an answer.
- `review.md`: comments on components, and changing their priority.
- `tasks.md`: the developer's own numbered tasks ("#12"), and how to read one. Read it when they
  name a task or ask what is ready to be developed, without waiting for a yes to anything.
- `schedule.md`: how to be sent a message later (check a release again, retry in a while), the
  same for every agent. Read it when you need to come back to something, without waiting to be
  asked for decisions or a flow.
- `queue.md`: how to hold the developer's message queue when something you were asked to do is left
  undone. The preamble already says when; read it for the details.
- `api.md`: the environment variables, the authentication, every endpoint with its fields, the
  errors, and a runnable bash script for each kind of artifact.

## Rules that always apply

1. Never generate or record any of this on your own initiative.
2. After you finish reviewing code, or writing or changing code, end your reply with one short
   question, in the language the developer writes in, asking whether they want you to generate
   decisions, a flow diagram, review comments or priorities. Ask for nothing else, and do not
   ask after an exchange that neither reviewed nor changed code.
3. If the developer says no, or does not answer, drop it. Do not ask again for the same work.
4. When they say yes, do what they chose and nothing more, then say in a sentence what you
   created and where it is (the chat's Decisions card, the Flow tab, the review queue).
5. Everything you write must be true of the code as it is: refer to files and lines that exist.
6. If `ATARAXIA_API_URL` or `ATARAXIA_API_TOKEN` is not set in your shell, tell the developer and
   stop (see `api.md`). Do not write to the app's database or try another route.
