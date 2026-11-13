#!/usr/bin/env bash
# Runs the built binary with `--version` and checks that it prints `ataraxia <semver>` and exits 0.
# `--version` opens no window, so this runs on a CI runner without a display, and it proves that
# the binary starts and links.
#
#   scripts/smoke-binary.sh path/to/ataraxia
set -euo pipefail

bin="${1:?usage: smoke-binary.sh <ataraxia binary>}"

if [ ! -x "$bin" ]; then
  echo "smoke test failed: $bin is not an executable file" >&2
  exit 1
fi

status=0
output="$("$bin" --version)" || status=$?
if [ "$status" -ne 0 ]; then
  echo "smoke test failed: '$bin --version' exited with status $status" >&2
  echo "$output" >&2
  exit 1
fi

# ataraxia 1.2.3, optionally with a pre-release or build suffix (1.2.3-rc.1, 1.2.3+build.5).
semver='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?'
if ! [[ "$output" =~ ^ataraxia\ $semver$ ]]; then
  echo "smoke test failed: expected 'ataraxia <semver>', got:" >&2
  echo "$output" >&2
  exit 1
fi
echo "ok: $output"
