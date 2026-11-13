#!/usr/bin/env bash
# Gathers what `tauri build` made for one target into the files a release carries, named
# ataraxia-<tag>-<target>.<ext>, each with a .sha256 beside it.
#
#   scripts/collect-release-files.sh TAG TARGET OUTDIR KIND...
#
# KIND is any of: tarball deb rpm appimage nsis msi. Each asked for must exist exactly once.
set -euo pipefail

tag="${1:?tag, like v0.1.0}"
target="${2:?target triple}"
out="${3:?output folder}"
shift 3
kinds=("$@")

release="src-tauri/target/${target}/release"
bundle="${release}/bundle"
mkdir -p "$out"

sum() {
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "$1")" && sha256sum "$(basename "$1")" > "$(basename "$1").sha256")
  else
    (cd "$(dirname "$1")" && shasum -a 256 "$(basename "$1")" > "$(basename "$1").sha256")
  fi
}

# One file, and only one, must match.
only() {
  local found=()
  while IFS= read -r file; do found+=("$file"); done < <(compgen -G "$1" || true)
  if [ "${#found[@]}" -ne 1 ]; then
    echo "expected exactly one file for $1, found ${#found[@]}" >&2
    ls -R "$bundle" >&2 || true
    exit 1
  fi
  echo "${found[0]}"
}

keep() {
  local source="$1" name="$2"
  cp "$source" "$out/$name"
  sum "$out/$name"
  echo "  $name"
}

for kind in "${kinds[@]}"; do
  case "$kind" in
    tarball)
      stage="$(mktemp -d)"
      cp "${release}/ataraxia" README.md CHANGELOG.md LICENSE "$stage/"
      archive="$out/ataraxia-${tag}-${target}.tar.gz"
      tar -C "$stage" -czf "$archive" .
      sum "$archive"
      echo "  $(basename "$archive")"
      ;;
    deb) keep "$(only "${bundle}/deb/*.deb")" "ataraxia-${tag}-${target}.deb" ;;
    rpm) keep "$(only "${bundle}/rpm/*.rpm")" "ataraxia-${tag}-${target}.rpm" ;;
    appimage) keep "$(only "${bundle}/appimage/*.AppImage")" "ataraxia-${tag}-${target}.AppImage" ;;
    nsis) keep "$(only "${bundle}/nsis/*-setup.exe")" "ataraxia-${tag}-${target}-setup.exe" ;;
    msi) keep "$(only "${bundle}/msi/*.msi")" "ataraxia-${tag}-${target}.msi" ;;
    *)
      echo "unknown kind: $kind" >&2
      exit 1
      ;;
  esac
done
