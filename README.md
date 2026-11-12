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
  - Model and reasoning effort are set per chat from the composer. Claude Code reads them at launch (`--model`, `--effort`), so a change restarts the agent and keeps the transcript; Codex sends them with each turn. OpenCode is not configurable from Concierge yet
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

## Shortcuts

- `Shift + ←/→` — previous/next space
- `Ctrl/Cmd + J` or `Ctrl/Cmd + \`` — toggle terminal panel
- Chat: `Enter` send, `Shift + Enter` new line, `Esc` stop the running turn
- Theme toggle in the header

## License

MIT. See [`LICENSE`](./LICENSE).
