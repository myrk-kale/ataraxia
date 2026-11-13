# Changelog

All notable changes to Ataraxia. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/). The notes of each release on GitHub
are the section of this file for its version.

## [Unreleased]

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

### Removed

- The MCP server (`ataraxia mcp`) and the MCP server screen in Settings.

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

[Unreleased]: https://github.com/myrk-kale/ataraxia/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/myrk-kale/ataraxia/releases/tag/v0.1.0
