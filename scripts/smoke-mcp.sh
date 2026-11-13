#!/usr/bin/env bash
# Starts the built binary as the MCP server (`ataraxia mcp`) and checks that it answers the
# protocol over stdio. It needs no display, so it can run on a CI runner, and it proves that the
# binary starts, links and opens its database.
#
#   scripts/smoke-mcp.sh path/to/ataraxia
set -euo pipefail

bin="${1:?usage: smoke-mcp.sh <ataraxia binary>}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

reply="$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | "$bin" mcp --db "$tmp/smoke.sqlite3")"

fail() {
  echo "smoke test failed: $1" >&2
  echo "$reply" >&2
  exit 1
}

grep -q '"serverInfo"' <<<"$reply" || fail "no initialize reply"
grep -q '"name":"ataraxia"' <<<"$reply" || fail "wrong server name"
grep -q 'ataraxia_record_decision' <<<"$reply" || fail "the tools are not listed"
echo "ok: $bin answers the MCP protocol"
