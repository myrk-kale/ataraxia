# Changelog

All notable changes to Ataraxia. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/). The notes of each release on GitHub
are the section of this file for its version.

## [Unreleased]

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

[Unreleased]: https://github.com/myrk-kale/ataraxia/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/myrk-kale/ataraxia/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/myrk-kale/ataraxia/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/myrk-kale/ataraxia/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/myrk-kale/ataraxia/releases/tag/v0.1.0
