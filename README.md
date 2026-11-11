# Concierge

Desktop environment for agent-assisted software development.

Concierge integrates coding agents (Claude Code, Codex, OpenCode) into a keyboard-first workspace with Chat, Code review, Decisions, Flow diagrams, contextual BTW investigations, and a real PTY terminal.

## Status

Greenfield. The product direction lives in [`Concierge_SPEC_v1.1.md`](./Concierge_SPEC_v1.1.md). UX reference:

- [Interactive prototype](https://concierge-workspace-poc-20261111.mikael3305.chatgpt.site)

## Architecture

- **Frontend:** React + HeroUI v3 + Tailwind CSS v4 (`apps/desktop`)
- **Desktop shell:** Tauri
- **Core:** single Rust crate under `src-tauri`, hexagonal layout (`domain` / `ports` / `app` / `adapters`)
- **Agent connectors:** Orca-shaped ports in Rust
  - OpenCode → ACP
  - Claude Code → custom stream-json / Agent SDK bridge
  - Codex → custom app-server

## Workspace layout

```text
apps/desktop/   # React UI
src-tauri/      # Rust core + Tauri (coming next)
```

## Development

Prerequisites:

- Node.js 22+
- pnpm 11+
- Rust stable (`rust-toolchain.toml`)
- Tauri system dependencies for your OS

```bash
pnpm install
pnpm dev
```

Rust toolchain is pinned by `rust-toolchain.toml`. After installing rustup:

```bash
rustup show
cargo --version
```

## License

MIT. See [`LICENSE`](./LICENSE).
