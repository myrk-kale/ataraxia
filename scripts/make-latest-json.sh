#!/usr/bin/env bash
# Writes the manifest the in-app updater reads (`latest.json`) from the files of a release and their
# signatures, to the standard output.
#
#   scripts/make-latest-json.sh TAG DIR NOTES_FILE REPOSITORY
#
# The updater asks for the platform it runs on, finds the package, downloads it and checks its
# signature. macOS offers the universal app to both architectures; Linux the AppImage of its
# architecture; Windows the installer.
set -euo pipefail

tag="${1:?tag, like v0.1.0}"
dir="${2:?folder with the release files}"
notes="${3:?release notes file}"
repo="${4:?owner/repository}"
version="${tag#v}"
base="https://github.com/${repo}/releases/download/${tag}"

# One platform: its manifest key, the file, in the folder, that carries it.
entry() {
  local key="$1" file="$2"
  test -s "${dir}/${file}" || { echo "missing ${file}" >&2; exit 1; }
  test -s "${dir}/${file}.sig" || { echo "missing ${file}.sig" >&2; exit 1; }
  jq -n --arg key "$key" --arg url "${base}/${file}" --rawfile sig "${dir}/${file}.sig" \
    '{($key): {signature: ($sig | rtrimstr("\n")), url: $url}}'
}

app="ataraxia-${tag}-universal-apple-darwin.app.tar.gz"
platforms="$(
  {
    entry darwin-aarch64 "$app"
    entry darwin-x86_64 "$app"
    entry linux-x86_64 "ataraxia-${tag}-x86_64-unknown-linux-gnu.AppImage"
    entry linux-aarch64 "ataraxia-${tag}-aarch64-unknown-linux-gnu.AppImage"
    entry windows-x86_64 "ataraxia-${tag}-x86_64-pc-windows-msvc-setup.exe"
  } | jq -s 'add'
)"

jq -n --arg version "$version" --rawfile notes "$notes" \
  --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson platforms "$platforms" \
  '{version: $version, notes: ($notes | rtrimstr("\n")), pub_date: $date, platforms: $platforms}'
