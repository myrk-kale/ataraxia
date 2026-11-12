# Concierge

Desktop environment for agent-assisted software development.

Concierge integrates coding agents (Claude Code, Codex, OpenCode) into a keyboard-first workspace with Chat, Code review, Decisions, Flow diagrams, contextual BTW investigations, and a real PTY terminal.

## Status

Shell + workspace persistence are in place (open repo, select worktree, create/resume chat sessions). Agent runtime comes next. Product direction: [`Concierge_SPEC_v1.1.md`](./Concierge_SPEC_v1.1.md). UX reference:

- [Interactive prototype](https://concierge-workspace-poc-20261111.mikael3305.chatgpt.site)

## Architecture

- **Frontend:** React + HeroUI v3 + Tailwind CSS v4 (`apps/desktop`)
- **Desktop shell:** Tauri 2 (`src-tauri`)
- **Core:** single Rust crate, hexagonal layout (`domain` / `ports` / `app` / `adapters`)
- **Agent connectors:** Orca-shaped ports in Rust
  - OpenCode → ACP
  - Claude Code → custom stream-json / Agent SDK bridge
  - Codex → custom app-server

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
pnpm --filter @concierge/desktop exec tauri dev
```

Frontend only:

```bash
pnpm dev
```

Rust checks:

```bash
cd src-tauri && cargo test && cargo check
```

## Shortcuts (shell scaffold)

- `Shift + ←/→` — previous/next space
- `Ctrl/Cmd + J` or `Ctrl/Cmd + \`` — toggle terminal panel placeholder
- Theme toggle in the header

## License

MIT. See [`LICENSE`](./LICENSE).
