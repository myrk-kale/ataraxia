# Changelog

All notable changes to Ataraxia. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/). The notes of each release on GitHub
are the section of this file for its version.

## [Unreleased]

## [0.17.0] - 2026-11-23

### Added

- Settings > Power chooses what stays on while there is work in progress: the computer and the
  screen (the default), the computer only, or nothing. The choice is saved and applies within a
  few seconds, without a restart.

### Fixed

- The screen no longer turns off and locks while agents have work pending: the default now keeps
  the display on as well as the system.
- Local MCP servers whose whole command line was typed in the Command field (`npx some-server
  --flag`) now start in every harness. The line is split into the program and its arguments when
  saved and when read, so servers saved that way work without being edited.
- Text typed in a chat made with + and left before its first message is no longer lost. That chat
  is still discarded, and the text comes back in the next chat made with +.

## [0.16.0] - 2026-11-22

### Added

- Every agent can explore the chat's worktrees with `code_graph`, a read-only Tree-sitter tool on
  the Ataraxia MCP server. It finds declarations, calls and imports with file and line locations,
  including local edits and new files. Agents start with the graph and can still use grep for text
  searches and gaps in coverage.

### Fixed

- The switch in Settings > Sound now mutes effects and cancels pending sounds. The app retries
  playback if its audio context stalls after an interruption.
- macOS uses a native assertion to prevent idle sleep while agents have work pending, on battery
  and AC power. Direct subagent replies keep the assertion active even when the parent chat is idle.

## [0.15.0] - 2026-11-21

### Added

- A chat in a workspace knows about the workspace's other conversations and can look into them,
  read-only, through three new tools of the `ataraxia` MCP server: `chats_list`, `chats_search`
  (a grep, regular expressions optional, filterable by who said it) and `chats_read` (a window at
  a time, never a whole chat). Every message says whether the developer (`user`) or an assistant
  (`agent`) wrote it. The first message of a chat lists the latest other conversations.
- New chats are named once their first exchange is over: the chat's own harness is asked for a title
  of a few words, in the language you wrote in, and the chat is renamed to it. Chats that already
  exist, and chats created with a title, keep theirs.
- `@` in the message field also offers the workspace's other conversations by title. Choosing one
  writes `@"chat:Title"`, and the agent reads that conversation piece by piece.
- The file tree in Code can create files and folders, rename, move and send to the Trash (right-click a
  file or folder, or use the buttons for the project root), and has a refresh button. Empty folders
  and files that are in the working tree but not yet in git show up in the tree too.
- Settings > Voice: "Stop when I go quiet" and "Wait before stopping". Turn the first off and dictation
  works like a voice recorder: it still writes as you speak, but only ends when you press the
  microphone button again. The second sets how long the quiet lasts (0.5 to 5 s) before it stops.

### Changed

- Enter while dictating stops the recording and writes the rest of what was said, instead of sending
  the message; it does nothing until that text has landed in the field.
- Dictation now waits 1.5 s of quiet before stopping by itself (it was 0.75 s, which cut people off
  between sentences).

## [0.14.2] - 2026-11-19

### Changed

- Tab in the message field takes the whole suggestion, like the Right arrow, instead of one word.

### Fixed

- The machine stays awake while an agent waits on a command or watch it left running in the
  background (the "Waiting on" chips). Only a working agent, a schedule, a queue or a usage-limit
  wait held it before, so it could sleep with the chat idle.
- Control with the backtick opens the terminal on a Mac keyboard that reports the key as a dead key
  or as another character. It now goes by the physical key, which is the apostrophe on a Brazilian
  keyboard.

## [0.14.1] - 2026-11-19

### Changed

- Buttons and fields now follow the size and weight their classes ask for. A global `font: inherit`
  rule outside any layer was overriding Tailwind, so every button looked a size and weight off.
- Deleting a skill or an MCP server asks in an app dialog instead of the system `confirm`.
- Settings, Keyboard shortcuts and the Memory graph have a close button.
- The Voice "Save" button sits next to the command field it saves, as a secondary button.
- The shortcuts dialog is wider, filter chips use the app radius, and the "+ New" buttons in Memory
  match the controls beside them.

### Fixed

- The Decisions card in the chat is as wide as the other blocks of a reply.
- Boxed selects keep their chevron at the edge, and segmented tabs fit their own text.
- Code > Components says what to do when there are changed files but nothing to rank, and the empty
  MCP servers list says where to add one.

## [0.14.0] - 2026-11-18

### Added

- Agent memory: Claude Code, Codex and OpenCode now share one memory that outlives any chat. Every
  chat gets an `ataraxia` MCP server with `memory_search`, `memory_get`, `memory_create`,
  `memory_update`, `memory_delete`, `memory_link`, `memory_unlink` and `memory_merge`. The agent is
  told to search before a task and to save what is worth keeping (a preference, a decision and its
  reason, a verified cause, a workflow) without asking. When memories disagree it asks you which is
  right and settles it. A memory has a kind (semantic, episodic, procedural, working), a scope
  (global, or one workspace) and a source (you said it, the agent verified it, the agent inferred
  it); only your own words can go to the global scope. A memory that looks like a password or a key
  is refused. It is on by default and can be switched off in Settings > Memory.
- The memory is a graph: memories link to each other as relates to, part of, depends on, caused by,
  supports, contradicts, supersedes or example of. The graph opens from a new icon in the header
  (`Ctrl/Cmd+Shift+G`), with filters, search, draggable nodes, conflicts in amber, and a panel to
  read, edit, link and delete a memory. Settings > Memory lists the same memories, and what an
  agent writes shows up as it happens. Deleting a workspace deletes the memories of that workspace.
- SVG in the chat: a fenced `svg` block in a reply is drawn as a picture, in the colours of the
  current theme. The agent is taught to use it for concept maps, mind maps and sketches that explain
  better than words. It is shown as an image, so nothing in it can run or load, and it has Expand,
  Code and Copy buttons.
- Dictation writes as you speak: each phrase lands in the field when you pause, what you are still
  saying shows live, and the recording ends by itself after about 0.75 s of silence. A new recording
  indicator shows the sound, the time and how close the pause is to ending it.

### Changed

- Dictation is several times faster on Apple silicon (the speech engine now uses the GPU) and
  uses the small Whisper model (190 MB) by default. The large-v3-turbo model stays available in
  Settings > Voice.
- A diagram asked for with no kind is a Mermaid diagram; a Flow diagram only when you say Flow.
- The search palette is redone: filter chips instead of select boxes, an icon per result type, the
  searched words highlighted, and arrow keys that move a highlight while you keep typing.

## [0.13.0] - 2026-11-18

### Added

- Global search opens with `Ctrl/Cmd+B` or the search button. Search conversations, artifacts,
  review comments and tasks, with filters for type, workspace and repository. The local SQLite
  full-text index covers existing history and stays current as items change.
- Private BTW: `Ctrl/Cmd+Shift+K` opens a BTW whose replies never reach the main chat. Its accent border
  and a "Private" note tell it apart.
- Review triage: in Code, Components, "Triage with a subagent" reorders the queue and leaves out what needs
  no review (formatting, renames, generated code). What it left out can be shown, and the triage undone.
  Your own priorities are never overwritten.
- Tasks open as a side panel, from a new icon in the header or `Ctrl/Cmd+T`.

### Changed

- Compare with now lives in Code, above the review list. Its default is "last commit" (what is pending in
  the working tree), the commits of the current branch are listed with their message, and there is no
  empty choice any more.
- Decisions are an artifact of the chat instead of a tab: a card above the message field opens a
  full-screen review with Approve and Reject (a rejection needs a comment). When all are reviewed, the
  main agent is told that everything was approved, or what was rejected and why. Decision threads are gone.
- BTW may edit files and run commands by default, and always runs on the worktree and branch on screen.
- The + button makes a chat that only stays once its first message is sent, and a new chat keeps the
  model and effort of the chat you were in.
- The terminal toggles with Control+backtick on every platform, the Mac included.
- Go to branch accepts branch links from Azure DevOps, GitHub, GitLab and Bitbucket, and HTTP(S) or
  SSH clone URLs with `#branch` appended.
- Picking a slash skill inserts its name in the message field. Send it as-is or add instructions.

### Fixed

- Codex can call Ataraxia's local API: its `workspace-write` sandbox cut every connection, localhost
  included, so pausing the queue, scheduling or recording decisions failed. Writing chats now run with
  network access; read-only helpers stay closed.
- A watch or background command Claude left running (`Monitor`, a background `Bash`) shows next to the
  subagents as "Waiting on: ..." until it ends, and the agent's own turn after it is shown as before.
- Subagents closed in a chat stay closed after visiting another space or chat.
- Claude Code no longer offers its own wakeup and cron tools, which never fired inside Ataraxia: the agent
  promised to come back and never did. Ataraxia's schedule is the way to come back later.
- Remote MCP servers registered in Settings (a `url` with no `type`, such as Notion) reach Claude Code: it
  silently dropped them before. OpenCode now gets them through its own config, where it can sign in to
  them, and Codex keeps MCP sign-ins it stores in a file.

## [0.12.1] - 2026-11-18

### Changed

- Dictation no longer depends on a Whisper you install yourself. Whisper is built into Ataraxia and runs on
  your computer; the first time you press the microphone it asks before downloading the model (about
  574 MB, once, with progress, cancellable and resumable) and then listens. Settings > Voice shows the
  state, downloads the model, sets the language (detected by default) and can still use a command of your
  own instead. The external `whisper-cli`, `mlx_whisper` and `whisper` lookups are gone.

## [0.12.0] - 2026-11-18

### Added

- Tasks, a screen of your own list. Type a title and press Enter and the task exists; click its card to
  add notes, mark it ready for development, tick it done or delete it. Every task has a number that is
  never reused: say `#12` in a chat and the agent fetches task 12 from Ataraxia's API (`GET /v1/tasks/12`,
  or `GET /v1/tasks?status=ready`), which every agent is told about and the guide explains.
- Go to a branch from a link: `Ctrl/Cmd+Shift+B` takes a pasted Azure DevOps link (or a GitHub or GitLab
  one), a branch name, a ref or a `git checkout` line, finds the branch here or on the remote, fetching
  when it must, and switches to it, in the repository of the workspace the link names.
- `Ctrl/Cmd+Enter` sends a message at once instead of queueing it: the agent stops and the message goes
  first. A Send now button sits beside Queue while the agent works.
- Dictation: a microphone button (and `Ctrl/Cmd+Shift+M`) records, turns what you said into text on this
  computer with a Whisper engine (`whisper-cli`, `mlx_whisper` or `whisper`, always the turbo model, or a
  command of your own in Settings > Voice) and writes it into the message field. Nothing is sent anywhere.
- Files named in the chat are links: `src/app.ts`, `app.ts:12`, `app.ts:12-20`, `app.ts#L12`, an absolute
  path inside a repository or a markdown link to one open in Code, in the right repository, with the
  lines marked.
- Notebooks: a `.ipynb` file opens as a notebook, with markdown rendered, code coloured and outputs
  (text, errors, images) shown under each cell. A button switches to the JSON, which is what is saved.
- BTW can edit files when you ask it to: the pencil in the bar, `Ctrl/Cmd+Enter`, or "Allow edits" in a
  read-only conversation. What it changes is recorded as a checkpoint of the chat, so it reaches the
  review queue.
- Agents are told to write a TLDR last: two to four lines, right before the closing question, saying what
  changed, why and what to check first.

### Changed

- Chats are listed by workspace, not by repository: the sessions list groups them under their workspace,
  the one on screen first, and choosing one from another workspace moves there. Each chat names the
  repository and branch it runs in.

### Fixed

- Streaming tokens no longer fight your scroll. Any move up, however slight, lets go of the stream at
  once, and being back at the bottom takes hold again.
- A BTW could never edit a file: it was always started read-only, with no way to say otherwise.

## [0.11.0] - 2026-11-17

### Added

- The code editor understands the tools of the repository. Linters and checkers it uses (ruff, mypy,
  flake8, eslint, biome) run when a file is opened and saved, and what they find is underlined with
  its message. Language servers it has installed (pyright, typescript-language-server,
  rust-analyzer, gopls) give completions as in VS Code, with their kinds, details, snippets and
  automatic imports, plus definitions and their own diagnostics. Nothing runs until you allow it,
  once per repository.
- Cmd or Ctrl+click on a name in the editor goes to where it is declared, by language server when
  there is one and by the syntax analyzer otherwise.
- Settings > Skills & MCP manages skills and MCP servers at three scopes: global, workspace and
  project. Each scope turns an item on, off or leaves it to the broader one, the narrowest wins, and
  each can define skills and MCP servers of its own, which workspaces could not before. Agents read
  it when a session starts.
- The branch selector lists the branches of the remote and fetches them, and "New branch…" opens a
  dialog to create one from another branch, a remote branch, a tag or a commit.
- An agent that left something undone can hold your message queue with a new API call, which every
  agent is told about. The queue waits when that turn ends, shows why, and goes on when you send a
  message or press Send now.
- What you type in a chat and do not send is kept per chat, across workspaces, tabs and restarts.

### Changed

- Tab in the message field brings the next word of the suggestion, or does nothing without one,
  instead of leaving the field. The Right arrow still takes all of it.
- Without a comparison picked, Code shows what is pending in the working tree against `HEAD`, and
  falls back to the agent's last turn when nothing is pending.

### Fixed

- Selected text in the editor was nearly invisible, above all on added, removed and reviewed lines.

## [0.10.0] - 2026-11-17

### Added

- Keep the system from sleeping while an agent is working, a message is queued, a schedule is
  waiting to fire or a usage-limit wait is pending, in any workspace.
- Autocomplete in the chat composer now suggests whole phrases and names from the code (found by
  the syntax analyzer), using packaged dictionaries for English, Portuguese (Brazil and Portugal),
  Spanish, French, German and Italian. A language model learns from the messages you send, in
  general and per chat, and keeps what it learned on disk across restarts. Choose the languages,
  turn parts off or forget what it learned in Settings > Autocomplete.

### Changed

- Word suggestions come from the app instead of a fixed list in the window.

### Fixed

- Answering a question with several steps no longer ends in "no pending permission": the prompt
  goes away once the answer is taken, and an answer is sent only once.

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

[Unreleased]: https://github.com/myrk-kale/ataraxia/compare/v0.16.0...HEAD
[0.16.0]: https://github.com/myrk-kale/ataraxia/compare/v0.15.0...v0.16.0
[0.11.0]: https://github.com/myrk-kale/ataraxia/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/myrk-kale/ataraxia/compare/v0.9.0...v0.10.0
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
