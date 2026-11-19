# Agent resources

Ataraxia provides portable skills, MCP servers, and workspace instructions to every agent
harness. Provider user and project customizations are isolated from Ataraxia sessions, while the
provider's authentication remains available.

## Chat input

`@` searches files from the active workspace. It accepts `*`, `**`, and `?` glob wildcards and
expands matching files when the message is sent. `/` contains only Ataraxia's `/help`, `/new`,
`/compact [instructions]`, and `/stop` commands; unsupported compaction options are reported for
the active agent.

## Skills

Use the open Agent Skills layout:

```text
~/.agents/skills/<skill-id>/SKILL.md
<repository>/.agents/skills/<skill-id>/SKILL.md
```

Each `SKILL.md` uses YAML frontmatter with a directory-matching, lowercase `name` and a `description`,
followed by Markdown instructions. The repository definition takes precedence when a user and
repository skill share an ID. Supporting files stay beside `SKILL.md` and paths in the skill remain
relative to it.

## MCP servers

User servers go in `$XDG_CONFIG_HOME/ataraxia/mcp.json` (default `~/.config/ataraxia/mcp.json`).
Repository servers go in `.mcp.json` at the repository root. Both files use the standard
`mcpServers` object:

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "node",
      "args": ["./tools/mcp-server.mjs"],
      "env": { "WORKSPACE": "." }
    }
  }
}
```

Repository entries override a user entry with the same server name. Ataraxia writes a private
merged MCP file for each chat and passes it to the active harness. Use normal MCP stdio fields
(`command`, `args`, `env`) or remote server fields (`url`, `headers`).

For OAuth servers such as Notion, use **Settings → Skills & MCP → MCP servers → Sign in**.
Complete authorization in the browser. New Codex, Claude Code, and OpenCode sessions use the
same authorization for that server URL. Ataraxia refreshes expiring tokens when a session starts.
Restart an existing session to pick up a new authorization or refreshed token.

Sign-in supports HTTPS MCP servers that publish OAuth metadata, support S256 PKCE, and allow
dynamic client registration. If you configured an Authorization header, the harness uses that
header directly.

## Instructions

User-wide guidance goes in `$XDG_CONFIG_HOME/ataraxia/AGENTS.md`. Repository-wide guidance uses
the conventional `AGENTS.md` at the repository root. Ataraxia loads those two files in that order
and introduces them to the agent at the start of a fresh process. Keep each file below 64 KiB.

The Ataraxia configuration root contains `AGENTS.md` and `mcp.json`; skills stay in the standard
`~/.agents/skills` and repository `.agents/skills` locations so they remain portable between
compatible agent tools.

## Provider isolation

Claude Code uses strict MCP configuration and loads the selected portable skills as a temporary
session plugin. Skill commands use the `ataraxia:` namespace; Claude's built-in skills may also
remain available. Codex receives a private `CODEX_HOME` for each chat with the selected MCP servers
and the active account's credentials. Ataraxia disables native project instructions, Codex apps
and plugins, and enables the selected skills in the Codex catalog.
OpenCode receives remote servers and local servers with a custom working directory through its
native configuration. It receives the remaining stdio servers through ACP. Ataraxia disables project configuration,
external skills, Claude compatibility files, and external plugins, then replaces the global config
directory with an empty per-chat directory. OpenCode denies skills by default and allows only the
Ataraxia-selected skill IDs. MCP credentials in generated files are restricted to the current user
on Unix systems.
