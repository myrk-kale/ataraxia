# Changelog

All notable changes to Ataraxia. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/). The notes of each release on GitHub
are the section of this file for its version.

## [Unreleased]

## [0.9.0] - 2026-11-17

### Added

- Stream reasoning and context usage from supported coding agents, with a copy action for each
  interaction and a confirmation when conversation compaction finishes.
- Suggest words locally in the chat composer, including words typed in the conversation.
- Resume work after a reported usage limit while the app is open, ahead of queued messages.
- Switch between the last two workspaces with `/workspace` or Alt+W.

### Changed

- Show account limits and conversation context as adjacent circular meters.
- Move to the next pending decision after a verdict and make rejection with a comment explicit.
- Load selected Claude Code skills through a native plugin while keeping resources isolated.

### Fixed

- Keep the animated chat background stationary as the queue grows and restore the last open chat
  when returning to a workspace.
- Preserve process exit details when an agent exits while a request is pending.
- Exclude the local pnpm cache from version control.

## [0.8.0] - 2026-11-16

### Added

- The chat's `/` picker now offers the active provider's commands, Ataraxia skills and configured
  MCP servers in one list.
- BTW conversations stay available as subagents for follow-up messages. Their chips can be hidden
  from the chat view without deleting the conversation.

### Changed

- Each completed BTW interaction adds a short summary of its latest question and answer to the
  main chat queue. The main agent treats it as a parallel update, not a new request to act.
- The workspace checks Git status on every refresh so externally changed files appear sooner.

### Fixed

- Provider slash commands can receive arguments without being checked against `/compact` rules.
- Codex sends configured HTTP MCP headers using its `http_headers` setting.
- The built-in terminal inherits the enriched `PATH` used to find agent CLIs.

## [0.7.0] - 2026-11-16

### Added

- One `/` command catalog and `@` file picker across Claude Code, Codex and OpenCode. File mentions
  expand `*`, `**` and `?` globs; the commands are `/help`, `/new`, `/compact` and `/stop`.
- Portable user and repository `AGENTS.md`, skills and MCP servers supplied by Ataraxia to every
  harness. Repository MCP servers require explicit trust before a session can use them.
- A chat settings view for listing active MCP processes and safely stopping one.

### Changed

- Provider settings and resources are isolated per harness while the provider account remains
  available for authentication.

### Fixed

- Claude's native `/compact` remains available while provider skills are isolated. OpenCode now
  honors the configured working directory of a local MCP server, and deleting chats removes their
  generated MCP and provider credential files.

## [0.6.0] - 2026-11-16

### Added

- Flowcharts with `subgraph ... end` are drawn as text too, with a titled frame round the nodes of
  each subgraph; subgraphs can be nested up to three deep. Each is laid out on its own and placed as
  one block, so frames never overlap. A `direction` inside a subgraph is honoured when no link joins
  it to the outside (as in Mermaid) and ignored otherwise. Still handed to the library: a link to a
  whole subgraph, an empty subgraph, more than 16 subgraphs, and the other things the text drawing
  never covered (`A & B`, two-way links, styled nodes, other kinds of diagram).
- Scheduled messages, the same for every agent. An agent that has to check something later (a
  release still building, a retry in ten minutes) asks Ataraxia through the local API and gets a
  message back at that time, on Claude Code, Codex and OpenCode alike. Schedules are kept per chat,
  so they survive a restart, a change of agent or a dead process. A "Scheduled" strip above the
  message field lists them with their next time and lets you cancel each one; the message they send
  shows as a "Scheduled" line in the transcript. Claude Code's own cron, wakeups and `/loop` are
  turned off in its place.

### Fixed

- Larger flowcharts in the chat are drawn as text like the small ones, not as the Mermaid library's
  small SVG. A chain deeper than 14 steps was piled up sideways on the last row and made the drawing
  too wide, and labels were cut at 40 characters. A chain can now be 40 steps deep, a long label is
  cut at spaces into several lines of its box, and the chart may hold 60 nodes and 100 links. Charts
  that were already drawn as text look the same.
- What Claude Code does on its own is no longer dropped. A wakeup it set, or the end of a command it
  left running in the background, started a turn that never reached the screen or the saved
  conversation; it now shows as a turn of its own.

## [0.5.1] - 2026-11-15

### Fixed

- An agent that starts fresh under an earlier transcript now knows the conversation continues. The
  notice "Earlier messages are shown for reference; the agent starts fresh" shows when the app was
  restarted and the harness could not pick the conversation up, when its process died, or when the
  model changed; in those cases the new agent began with no context at all, because the record of the
  conversation was only written when you switched harness or account. Now the agent's first message
  tells it that the chat continues an earlier conversation, and where it is saved, and asks it to
  read only the parts it needs: the end first, or a search for the words of your message. It is told
  once, with the first message after the restart.

## [0.5.0] - 2026-11-15

### Added

- A chat picks its conversation up again. Reopening a chat under the same model now goes on with
  what the agent already knows, so the "agent starts fresh" notice no longer shows. Claude Code
  resumes its session, Codex its thread and OpenCode its session; when the harness no longer has it,
  a new one begins and the notice shows. Changing the model, even back to an earlier one, begins a
  new conversation and keeps the old messages as reference; effort and agent never do.
- New chats start with the model and effort last chosen for their harness.
- `/` and `@` in the message field, the same for every harness. `/` runs an action of the agent,
  a command or a skill, and only counts at the very start of the message (Claude Code and OpenCode
  list their commands, Codex its skills and custom prompts). `@` points at something for the agent
  to look at: a file or folder of the chat's repositories (those of the other repositories of a
  workspace by absolute path, which is how the agent reaches them) or one of the harness's agents.
  The list opens above the field; the arrows, Enter or Tab and Esc work it, and choosing a folder
  goes on inside it. A message that starts with a command goes out as typed, so Ataraxia's own
  introduction waits for the next message.
- Taking a message out of the queue with its X puts the words back in the message field when the
  field is empty, so you can edit it or send it again. With something typed there, the message is
  only removed. Pictures are not brought back.

- Right-click opens the app's menu instead of the webview's (Reload, Inspect…). In a text field it
  offers Undo, Redo, Cut, Copy, Paste and Select All; on selected text, Copy; on a web link, Open
  Link and Copy Link Address; on a picture, Copy Image; in the terminal, Copy (what is selected
  there) and Paste. Elsewhere nothing opens. The code editor keeps its own menu, and in development
  Shift + right-click still opens the webview's, for the inspector.

### Fixed

- Changing the model no longer shows "claude exited": the old process being stopped was reported as
  a failure of the new one.
- The agent's questions (Claude Code's AskUserQuestion) are shown and answered. Before, the dialog
  only said "Allow AskUserQuestion" and answering ended in an error. Questions, and permissions to
  run something, now take the place of the message field instead of a dialog, as in Claude Code:
  numbered options you can pick with the arrows, Enter or a number key, several ticked at once when
  the question allows it, and a line to answer in your own words. Esc skips (declines) it, and the
  field comes back, with what you had typed, once it is settled.
- The animated background no longer rises when the message field grows with what is typed in it
  (the field keeps its cap).

## [0.4.0] - 2026-11-14

### Added

- Message queue. While the agent works, Enter (or the Queue button) puts what you type in a queue
  above the composer instead of refusing it, and the messages go out one after another as each turn
  ends well. "Send now" on a queued message stops the running turn and sends that message next, ahead
  of the rest. A turn you stopped or that failed pauses the queue; the queue keeps going while you
  look at another chat.

- Pictures in the chat. Paste an image into the message field or choose files with the paperclip
  (PNG, JPEG, GIF or WebP, 5 per message, 5 MB each; other files are refused with a reason for now).
  They show as thumbnails before sending and in the message after. Claude Code gets them as images,
  Codex as local images, and OpenCode gets the file's path. Queued messages keep their pictures.
- The opening animation follows the time of day: sunrise over a snowy peak in the morning, a bright
  island in the afternoon, the savanna at sunset in the evening and the sea under the moon at night.
  It reads this computer's clock and needs nothing from the network.
- Agent profiles, for people with more than one account on an agent. Settings > Agent profiles keeps,
  for Claude Code, Codex and OpenCode, any number of profiles besides the default: a name, a colour
  and the command that starts it, written as in a terminal (for example
  `CLAUDE_CONFIG_DIR=~/.claude-work claude`; leave the program out to use the usual one). One
  profile per agent is in use, and the form says what a command would run before it is saved. The
  profile in use shows as a soft blur of its colour behind the agent's mark in the composer, with
  its name on hover. A chat that is already open switches to the new profile at its next message
  (a turn in progress is never interrupted), and the new agent is told where the conversation so
  far is kept. The limits meter follows the account: each profile has its own numbers, and the
  details name the profile.
- Provider limits in the composer. Next to the agent's name, a small meter shows the five-hour and
  weekly limits of the provider the chat runs on (Claude Code and Codex), as a bar and a number each.
  Click it for when each window resets, the plan, and how long ago the provider reported. The last
  known numbers are kept, so they show at start-up; a window that has since reset shows 0%; from 75%
  the number turns amber and from 90% red, always with an icon. Providers that report no limits
  show no meter.
- A Copy button on tables (as cells, and as an HTML table), code blocks and diagrams.
- Mermaid flowcharts are drawn as animated text on the graphics card (WebGL2), in the app's colours
  and the code font, instead of by the Mermaid library: the drawing is about 22 KB of code against
  about 2 MB, appears in a third of the time, and costs nothing while it is paused or out of view.
  The animation (data flow by default, repeating) can be paused with a click on the diagram, and
  each diagram has its own choice of animation (draw in, data flow, step by step, node pulse,
  typing, state changes, matrix glitch, or none). A diagram opens full screen, where it can be
  zoomed (wheel, pinch, buttons or + and -) and dragged, and is drawn again at each zoom so it stays
  sharp. It has one Copy button, which copies the Mermaid source, and a description for screen
  readers. Settings > Appearance > Diagrams has the default animation, Repeat, and the style of the
  lines (square, all rounded, double, heavy or plain ASCII). Links go round the boxes and keep off
  each other unless they share an end. Other kinds of diagram, subgraphs and anything the text
  drawing cannot show faithfully, and a machine without WebGL2, still get the Mermaid library,
  loaded only then.
- The agent is told to ask which kind of diagram the developer wants, a Flow diagram or a Mermaid
  one, when a request for a diagram does not say, instead of choosing.
- Agent profiles, for people with more than one account on an agent. Settings > Agent profiles keeps,
  for Claude Code, Codex and OpenCode, any number of profiles besides the default: a name, a colour
  and the command that starts it, written as in a terminal (for example
  `CLAUDE_CONFIG_DIR=~/.claude-work claude`; leave the program out to use the usual one). One
  profile per agent is in use, and the form says what a command would run before it is saved. The
  profile in use shows as a soft blur of its colour behind the agent's mark in the composer, with
  its name on hover. A chat that is already open switches to the new profile at its next message
  (a turn in progress is never interrupted), and the new agent is told where the conversation so
  far is kept. The limits meter follows the account: each profile has its own numbers, and the
  details name the profile.
- Provider limits in the composer. Next to the agent's name, a small meter shows the five-hour and
  weekly limits of the provider the chat runs on (Claude Code and Codex), as a bar and a number each.
  Click it for when each window resets, the plan, and how long ago the provider reported. The last
  known numbers are kept, so they show at start-up; a window that has since reset shows 0%; from 75%
  the number turns amber and from 90% red, always with an icon. Providers that report no limits
  show no meter.
- A Copy button on tables (as cells, and as an HTML table), code blocks and diagrams.
- Mermaid flowcharts are drawn as animated text on the graphics card (WebGL2), in the app's colours
  and the code font, instead of by the Mermaid library: the drawing is about 22 KB of code against
  about 2 MB, appears in a third of the time, and at rest costs the page nothing. One animation
  plays once as a diagram comes into view (draw in, data flow, step by step, node pulse, typing,
  state changes or matrix glitch, chosen in Settings > Appearance > Diagrams, which also has Keep
  animating and the style of the lines: square, all rounded, double, heavy or plain ASCII), then it
  rests. A diagram has Replay, Copy text (the drawing itself, as text) and Copy source, and a
  description for screen readers. Links go round the boxes and keep off each other unless they
  share an end. Other kinds of diagram, subgraphs and anything the text drawing cannot show
  faithfully, and a machine without WebGL2, still get the Mermaid library, loaded only then.
- Selecting text in the Code editor shows a small bar next to it: Ask, Comment and Copy. Ask opens
  BTW with the selection attached; the bar names the selection, its file and lines, and the agent is
  told the user has that text selected, in that file, so "this" means it.
- Chats can be deleted from the Sessions list, with a second click to confirm. Their messages,
  pictures, checkpoints, decisions and diagrams go; the code does not.

### Changed

- A long chat no longer gets heavy. Only the messages and tool calls on screen (and a few either
  side) are in the page; the rest are blank space of the right height, so the memory and the work
  of a chat stay those of one screen however long it runs. While a reply streams in, only that
  reply is redrawn instead of the whole conversation, a tool call's input and output are only in
  the page while it is open (and it stays open when you scroll back), pictures are kept in a
  bounded cache, and a diagram that scrolls back into view is not drawn again. In a test chat of
  2,000 messages and tool calls the page held 453 elements instead of 14,945.
- A message you send is in its bubble at once and the loader starts at once, without waiting for
  the app: the app first marks where the working tree stands (a snapshot of git in each
  repository), which could leave the window looking frozen for a moment. The app's own report of
  the message then takes the place of the one shown, without drawing it again, pictures included.
  If the app refuses the message it is taken back out and its text and pictures go back in the
  field, ahead of anything typed meanwhile. A message sent to the queue is listed at once too.
- The loader while the agent works is three dots that rise and settle in a wave, in the colour of
  the text, and still when the system asks for reduced motion.
- Shift with Up or Down changes space wherever focus is, the message field, the editor and the
  terminal included.

### Fixed

- Streamed text could show every word twice (`VouVou usar usar a a skill skill`) when an event
  reached the window twice. Every agent event now carries a number and the chat applies each
  number once, so a repeated delivery changes nothing. The stored conversation was never affected.

- What the agent writes through the local API (a diagram, a decision, a message on a decision, a
  linked commit, a comment or a priority) now shows up in the open tab at once. It was saved, but the
  window was never told, so a Flow or Decisions tab that was already open stayed as it was until the
  chat was reopened. A diagram that is new is also the one the Flow tab shows.
- The agent can record a decision or a diagram in a chat that has not changed any code. Before, the
  local API refused ("nothing has changed in this chat yet"), though neither is about a diff.

## [0.3.0] - 2026-11-13

### Added

- The empty chat shows the A of ATARAXIA as slow, animated ASCII art behind the title. When the chat
  begins the A rises away and the drifting field of characters stays behind the conversation. It is
  faint behind the words, follows the cursor with a soft light, stops while the window is hidden and
  is a still picture with reduced motion.
- Settings, Appearance, "Animated background" turns all of it off.

### Changed

- On macOS the header is the window's title bar: the system bar is gone, the window buttons sit over
  the app's own header, and its empty parts move the window (a double click zooms it). Windows and
  Linux keep their native bar.
- The header no longer carries the A logo, and the opening fades into the interface instead of
  landing the first A there.

## [0.2.0] - 2026-11-13

### Added

- Workspaces: a named set of repositories. The agent of every chat in a workspace can read and change
  all of them, while the app still looks at one repository at a time. The workspace selector replaces
  the repository selector in the header, a repository selector appears from two members on (in the
  header and at the top of Code), and "New workspace…" and "Edit this workspace…" manage them. A
  repository on its own is a workspace of one and looks as before.
- A turn that changes several repositories leaves a checkpoint in each, reviewed on its own, and the
  repository selector says what the agent changed in every one and how much is unreviewed.
- Files named to the API as `<repository>/<path>` open in the right repository, and the guide explains
  the convention.

### Changed

- Chats belong to the workspace, not to a repository, so changing repository inside a workspace keeps
  the chat open. Existing repositories and chats move into a workspace of one each.
- The comparison picked in "Compare with…" is remembered per chat and repository.

## [0.1.1] - 2026-11-13

### Added

- macOS: a Homebrew cask (`brew install --cask myrk-kale/tap/ataraxia`) that puts `Ataraxia.app` in
  Applications. The release now carries the app as `….app.tar.gz`; the formula still installs the bare
  binary for the command line.

### Changed

- Agents now act on Ataraxia through a local HTTP API instead of an MCP server. While the app runs it
  serves the API on `127.0.0.1`, each agent process of a chat gets `ATARAXIA_API_URL`,
  `ATARAXIA_API_TOKEN` and `ATARAXIA_SESSION_ID`, and the guide each agent reads on demand (now with an
  `api.md` page in place of `tools.md`) explains how to call it from bash with curl. The token belongs
  to one chat, and is read-only in hidden investigation sessions.
- The release smoke test and the Homebrew formula test run `ataraxia --version` instead of starting the
  MCP server.
- The terminal shortcut is now `` Ctrl/Cmd+` `` only; `Ctrl/Cmd+J` no longer opens it. The terminal takes
  keyboard focus when it opens, and focus goes back to where it was when it closes.

### Removed

- The MCP server (`ataraxia mcp`) and the MCP server screen in Settings.

### Fixed

- The Files tree, the Changed list and the open file now follow the repository by themselves: a
  `git rm`, `checkout`, `stash` or `pull` in a terminal, or a file made, renamed or deleted by another
  program, shows up within a few seconds. A file that disappears while open is marked removed, keeps
  its text, and never loses unsaved edits.
- Code no longer shows a diff nobody asked for. With no comparison chosen it shows only what the agent
  changed in its last turn (the old comparison and the automatic working tree against `HEAD` are
  gone), and otherwise says why there is nothing to show and to pick a branch or a commit in
  "Compare with…".
- The label above the Changed list (`feat/x against develop`) is cut with an ellipsis instead of
  spilling over the editor, keeps the refresh button in place and shows the full text on hover.

## [0.1.0] - 2026-11-13

First release.

### Added

- **Chat** with Claude Code, Codex and OpenCode through one agent host: streaming, tool cards,
  permissions, cancel, a persisted transcript, subagent conversations, and switching the agent
  mid-chat (the conversation is written to a file and the new agent is told where it is).
- **Code review** built on the syntax tree and git: a flat list of the components that changed,
  ranked by how much they need a look, with the reason shown when one is opened; the changed files
  and the project tree; a Monaco editor with its own theme, line wrapping (`Alt+Z`) and the previous
  version of a file (`Alt+V`).
- **Decisions** kept as threads, **Flow** diagrams whose nodes point at real files, and **BTW**, a side
  conversation that works in every space, knows what is open, and is a subagent of the chat.
- An MCP server (`ataraxia mcp`) so agents can read and write these artifacts, and a short context
  given to the chat's agent: it never generates them unasked, offers them after a review, and reads
  its guide only once asked.
- **Eleven themes**, each with a light and a dark variant, import of any VS Code colour theme, and
  typeface and size for the interface, chat, code and terminal.
- A few light sounds (changing space, choosing a model, an approval chime), off in Settings > Sound.
- A real PTY terminal, and the opening animation.
- Releases built by the pipeline: macOS (a universal binary, installed with Homebrew), Linux (`x86_64`
  and `aarch64`: `.deb`, `.rpm`, `.AppImage` and a tarball), Windows (`.exe` installer and `.msi`), a
  Homebrew tap for macOS and Linux, and the `ataraxia-ide` crate.

[Unreleased]: https://github.com/myrk-kale/ataraxia/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/myrk-kale/ataraxia/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/myrk-kale/ataraxia/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/myrk-kale/ataraxia/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/myrk-kale/ataraxia/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/myrk-kale/ataraxia/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/myrk-kale/ataraxia/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/myrk-kale/ataraxia/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/myrk-kale/ataraxia/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/myrk-kale/ataraxia/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/myrk-kale/ataraxia/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/myrk-kale/ataraxia/releases/tag/v0.1.0
