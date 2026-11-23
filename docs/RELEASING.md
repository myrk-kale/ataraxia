# Releasing Ataraxia

Everything a release contains is built by GitHub Actions, on the platform it is for. Nothing is built
or uploaded from a laptop.

```text
git tag vX.Y.Z  ──►  Release workflow
                      ├─ ci                CI workflow: lint, typecheck, tests, build, cargo fmt/test/check
                      ├─ version           Cargo.toml, tauri.conf.json, the tag and the CHANGELOG agree
                      ├─ build  (x4)       macOS universal · Linux x86_64 · Linux aarch64 · Windows x64
                      │                    each smoke-tests the binary (`--version`), signs the package the
                      │                    in-app updater installs, and attests its files
                      ├─ release           writes latest.json, checks the files and their checksums,
                      │                    creates the GitHub release
                      ├─ homebrew          installs the formula on macOS and Linux, then pushes it to the tap
                      └─ crates            dispatches crates.yml, which publishes the crate
```

## What a release carries

| Platform | Files |
| --- | --- |
| macOS (universal: Apple silicon and Intel) | `ataraxia-vX.Y.Z-universal-apple-darwin.app.tar.gz` (`Ataraxia.app`, for the cask) and `….tar.gz` (the bare binary, for the formula and `cargo binstall`). There is no installer: macOS is installed with brew |
| Linux x86_64 and aarch64 (built on Ubuntu 22.04) | `….deb`, `….rpm`, `….AppImage`, `….tar.gz`, for each architecture |
| Windows x64 | `….-setup.exe` (NSIS installer, per user or per machine), `….msi` |

Each has a `.sha256`. Four of them also have a `.sig`, the minisign signature the app checks before it
installs an update (the macOS `.app.tar.gz`, the two AppImages and the Windows `-setup.exe`), and the release
carries `latest.json`, the manifest the app reads to find them (see "In-app updates"). That makes 29 files. The Homebrew formula (`brew install myrk-kale/tap/ataraxia`, the binary on macOS and
Linux) and the cask (`brew install --cask myrk-kale/tap/ataraxia`, `Ataraxia.app` in Applications on
macOS) are generated from those checksums by `packaging/render.sh`. The Homebrew workflow installs the
cask on a macOS runner and runs `ataraxia --version` from the installed app before it pushes anything. The crate is `ataraxia-ide` (the name `ataraxia` on crates.io belongs to
another project); its binary is still `ataraxia`.

## Cutting a release

1. Put the new version in `src-tauri/Cargo.toml` and in `src-tauri/tauri.conf.json` (the workflow refuses
   to run if they differ), and run `cargo check` so `src-tauri/Cargo.lock` follows.
2. In `CHANGELOG.md`, move what is under `[Unreleased]` to a new `## [X.Y.Z] - date` section. Its text
   is the release notes.
3. Merge that through a pull request, and wait for the CI.
4. Tag the merge commit and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

The workflow does the rest. A tag that is not `v<Cargo version>`, or a version without a CHANGELOG
section, stops it before anything is built.

## Rehearsing

**Actions > Release > Run workflow** builds every package exactly as a tag would and keeps the files on
the run (as `dist-*` artifacts), but publishes nothing: no release, no tap, no crate. Do it after
touching the pipeline, or the bundle settings in `src-tauri/tauri.conf.json`.

## One-time setup

These live in the repository settings (Settings > Secrets and variables > Actions).

| Name | Kind | What it is |
| --- | --- | --- |
| `HOMEBREW_TAP_DEPLOY_KEY` | secret | The private half of an SSH key whose public half is a deploy key, with write access, on `myrk-kale/homebrew-tap` |
| `TAURI_SIGNING_PRIVATE_KEY` | secret | The private updater key: the text of `~/.tauri/ataraxia-updater.key`. A tag without it is stopped by the version job |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | The key's password. Leave it out when the key has none (the current one has none) |
| `PUBLISH_CRATE` | variable | `true` to publish the crate in a release; anything else skips it |

The tap is shared with other projects; this one adds `Formula/ataraxia.rb` and `Casks/ataraxia.rb`. The crate needs no secret: it
is published with Trusted Publishing (below).

## Trusted Publishing on crates.io

`crates.yml` publishes without any stored token. On each run GitHub gives the job an OIDC token, and
`rust-lang/crates-io-auth-action` exchanges it for a short-lived crates.io token limited to the crate.
The setting that makes crates.io accept this is on the crate's page, Settings > Trusted Publishing:
repository `myrk-kale/ataraxia`, workflow `crates.yml`, no environment. If the repository or the
workflow file is renamed, that entry has to be changed too.

The same page has a switch that requires Trusted Publishing for every new version, which turns off
publishing with an API token altogether.

To check the setup without publishing, run **Actions > crates.io > Run workflow** with a tag that is
already published: the sign-in runs first, and the publish is skipped.

## In-app updates

A running app looks for a newer release a few seconds after it opens and every six hours. It reads
`https://github.com/myrk-kale/ataraxia/releases/latest/download/latest.json`, which lists, per platform, the
package to download and its signature. When the version there is newer it offers it; if the person agrees, the
app downloads the package, checks the signature against the public key in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`), installs it, and restarts.

| Platform | Package the updater installs | Notes |
| --- | --- | --- |
| macOS | the universal `.app.tar.gz` | replaces `Ataraxia.app` where it is; asks for an administrator password if the folder is not writable. Never offered to the bare binary (Homebrew formula, `cargo install`) |
| Windows | the `-setup.exe`, in passive mode | the installer closes the app and starts it again |
| Linux | the `.AppImage` of its architecture | only when the app was started from an AppImage. A `.deb` or `.rpm` belongs to the package manager and is never offered an update |

A version that already contains this feature can update itself; one released before it cannot, and has to be
updated by hand once (`brew upgrade`, or the installer).

The key pair is made once with `tauri signer generate`. The public half is in `tauri.conf.json`; the private
half is the secret above. **Keep a copy of the private key somewhere safe.** If it is lost, no installed app
can be updated again: they trust only the public key they were built with, so a new key has to be shipped by
hand in a release people install themselves. If it leaks, treat it the same way: replace the pair and ship the
new public key by hand.

`scripts/sign-updater-files.sh` signs the packages and `scripts/make-latest-json.sh` writes the manifest; both can
be run on a folder of release files to see what a release would publish. A rehearsal (Actions > Release > Run
workflow) signs too, when the secret is there.

## Re-running a part

- The tap, for a tag that is already released: **Actions > Homebrew > Run workflow**, with the tag.
  The scripts come from `main`, so a fix there applies to an existing release.
- The crate: **Actions > crates.io > Run workflow**, with the tag. It skips a version that is already
  published.

## Not done yet

- **Signing.** The Windows installer is not Authenticode-signed, so SmartScreen warns on first run (the
  README says what to click). The macOS app is not signed or notarised with an Apple Developer ID; the cask
  removes the quarantine mark instead. Signing either would add a certificate as a secret and a step in the
  `build` job; `tauri build` reads them from environment variables.
- **Windows on Arm** and a Linux `musl` build.
