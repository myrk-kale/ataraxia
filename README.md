# Concierge

Desktop environment for agent-assisted software development.

Concierge integrates coding agents (Claude Code, Codex, OpenCode) into a keyboard-first workspace with Chat, Code review, Decisions, Flow diagrams, contextual BTW investigations, and a real PTY terminal.

## Status

Shell, workspace persistence, a retractable real PTY terminal, and the Chat space are in place. Chat talks to OpenCode (ACP), Claude Code (stream-json) and Codex (app-server) through one agent host, with streaming, tool cards, approve/deny prompts, cancel, and a persisted transcript. Code, Decisions, BTW and Flow come next. Product direction: [`Concierge_SPEC_v1.1.md`](./Concierge_SPEC_v1.1.md). UX reference:

- [Interactive prototype](https://concierge-workspace-poc-20261111.mikael3305.chatgpt.site)

## Architecture

- **Frontend:** React + HeroUI v3 + Tailwind CSS v4 (`apps/desktop`)
- **Desktop shell:** Tauri 2 (`src-tauri`)
- **Core:** single Rust crate, hexagonal layout (`domain` / `ports` / `app` / `adapters`)
- **Agent connectors:** Orca-shaped ports in Rust
  - OpenCode → ACP
  - Claude Code → custom stream-json (`--permission-prompt-tool stdio`)
  - Codex → custom app-server
  - Provider CLIs are found on `PATH` plus common install dirs; override with `CONCIERGE_OPENCODE_BIN`, `CONCIERGE_CLAUDE_BIN`, `CONCIERGE_CODEX_BIN`
  - Claude Code starts with `--permission-mode auto`; set `CONCIERGE_CLAUDE_PERMISSION_MODE` to another mode (e.g. `acceptEdits`), or to an empty value to use your own Claude settings
  - Agent, model and reasoning effort are set per chat from the composer. The lists come from the live session where the provider reports them (Codex `model/list`, OpenCode ACP config options) and from `.claude/agents` / `.codex/agents` on disk. Claude Code reads them at launch (`--agent`, `--model`, `--effort`), so a change restarts the agent and keeps the transcript; OpenCode and Codex apply them live. Codex has no agent switch in its protocol, so a chosen agent is named in each prompt
  - Subagents show up as a small switcher above the composer. Each one opens as its own conversation, streaming while it works, and the composer there writes to that subagent. Claude relays the message through the main agent's `SendMessage` tool (needs the `agentId` Claude reports when the subagent returns), Codex starts a turn on the subagent's thread, OpenCode prompts its child session. Subagent conversations are kept for the running app, not saved to the database
  - Claude runs most subagents in the background: the call returns at once with an `output_file`, a live transcript of the subagent. Concierge follows that file to show its conversation as it works, keeps the subagent open past the turn, and shows the report the main agent gives by itself when it finishes
  - Claude only forwards complete subagent messages (not token deltas); Concierge sets `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` so their text is included
  - Set `CONCIERGE_DEBUG_FRAMES=/path/to/file` to append every raw line exchanged with a provider CLI (`<` from it, `>` to it). It contains the whole conversation, so it is off by default
  - The provider selector in the top bar changes the harness of the open chat (the transcript stays, the new agent starts fresh)
  - Codex starts with `on-request` approvals, the `workspace-write` sandbox and `approvalsReviewer: auto_review` (a reviewer agent decides eligible requests); set `CONCIERGE_CODEX_APPROVALS_REVIEWER=user` to be asked for everything, or empty to use your own Codex config

## Workspace layout

```text
apps/desktop/   # React UI (HeroUI)
src-tauri/      # Rust core + Tauri (one crate)
```

## Development

Prerequisites:

- Node.js 22+
- pnpm 11+
- Rust 1.85+ (`cargo` / `rustc` on `PATH`; Homebrew Rust works if rustup cannot reach `static.rust-lang.org`)
- Tauri system dependencies for your OS

```bash
pnpm install
pnpm tauri:dev
```

Frontend only (the browser gets a built-in Tauri mock, dev builds only, so the UI renders with sample data):

```bash
pnpm dev
# http://localhost:1420/?state=empty|fresh|permission|working|restored previews other chat states
```

Rust checks:

```bash
cd src-tauri && cargo fmt --check && cargo test && cargo check
pnpm typecheck && pnpm test && pnpm build
```

Connector tests use scripted stand-ins for the provider CLIs (`src-tauri/tests/fixtures/*.py`, needs `python3`); no real CLI is executed.

## Empty chat

An empty chat shows the Concierge axolotl (drawn by `apps/desktop/scripts/generate-axolotl.py`, which writes `src/chat/axolotlArt.ts`; rerun it after changing the drawing) floating (and blinking now and then) over animated dot waves. The waves are white on the dark theme and black on the light one. Press the empty background and drag to move them: the dots follow the pointer with a soft pull and ease back to their place when you let go (a plain click gives them a light push outward). Once the conversation starts the axolotl goes away and the waves stay behind it, turned down so the text reads. They pause while the window is hidden, and with reduced motion enabled they stand still and the axolotl does not blink.

## Shortcuts

- `Shift + ←/→` — previous/next space
- `Ctrl/Cmd + J` or `Ctrl/Cmd + \`` — toggle terminal panel
- Chat: `Enter` send, `Shift + Enter` new line, `Esc` stop the running turn
- Theme toggle in the header

## License

MIT. See [`LICENSE`](./LICENSE).
