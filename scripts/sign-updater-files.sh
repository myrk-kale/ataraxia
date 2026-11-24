#!/usr/bin/env bash
# Signs, for the in-app updater, the one package each platform offers it: the macOS app (.app.tar.gz),
# the Linux AppImage and the Windows installer (-setup.exe). Each gets a `.sig` beside it, which the
# app checks against the public key in tauri.conf.json before it installs anything.
#
#   TAURI_SIGNING_PRIVATE_KEY=... scripts/sign-updater-files.sh DIR
#
# The key is read from TAURI_SIGNING_PRIVATE_KEY (its text or a path), and its password, if it has one,
# from TAURI_SIGNING_PRIVATE_KEY_PASSWORD. TAURI_BIN overrides the tauri CLI to run.
set -euo pipefail

dir="${1:?usage: sign-updater-files.sh <folder with the release files>}"
tauri="${TAURI_BIN:-apps/desktop/node_modules/.bin/tauri}"

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "TAURI_SIGNING_PRIVATE_KEY is not set" >&2
  exit 1
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

signed=0
shopt -s nullglob
for file in "$dir"/*.app.tar.gz "$dir"/*.AppImage "$dir"/*-setup.exe; do
  rm -f "${file}.sig"
  "$tauri" signer sign "$file" >/dev/null
  test -s "${file}.sig" || { echo "no signature was written for $file" >&2; exit 1; }
  echo "  $(basename "$file").sig"
  signed=$((signed + 1))
done

if [ "$signed" -eq 0 ]; then
  echo "nothing to sign in $dir" >&2
  exit 1
fi
