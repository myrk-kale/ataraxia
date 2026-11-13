#!/usr/bin/env bash
# Fills in a Homebrew template with a version and the checksums of that release's files.
#
#   packaging/render.sh formula VERSION SHA_MACOS SHA_LINUX_X86_64 SHA_LINUX_AARCH64
#   packaging/render.sh cask    VERSION SHA_APP
#
# Prints the result on stdout.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
kind="${1:?formula or cask}"
version="${2:?version}"

sha() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || { echo "not a sha256: $1" >&2; exit 1; }
  echo "$1"
}

case "$kind" in
  formula)
    sed \
      -e "s/@VERSION@/${version}/g" \
      -e "s/@SHA_MACOS@/$(sha "${3:?sha macos}")/" \
      -e "s/@SHA_LINUX_X86_64@/$(sha "${4:?sha linux x86_64}")/" \
      -e "s/@SHA_LINUX_AARCH64@/$(sha "${5:?sha linux aarch64}")/" \
      "$here/ataraxia.rb.in"
    ;;
  cask)
    sed \
      -e "s/@VERSION@/${version}/g" \
      -e "s/@SHA_APP@/$(sha "${3:?sha app}")/" \
      "$here/ataraxia-cask.rb.in"
    ;;
  *)
    echo "unknown kind: $kind" >&2
    exit 1
    ;;
esac
