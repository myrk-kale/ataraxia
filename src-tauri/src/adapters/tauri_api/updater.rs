//! Self-update: looks for a newer release, downloads it, installs it and restarts the app.
//!
//! The release workflow publishes `latest.json` and a minisign signature for every package it
//! offers; the updater plugin checks that signature against the public key in `tauri.conf.json`
//! before it installs anything. Nothing here decides what is trusted.

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update found by the last check, kept until it is installed.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    /// `None` when the server did not say how big the download is.
    pub total: Option<u64>,
}

/// How this copy of the app was started, as far as updating itself is concerned.
struct Install {
    debug_build: bool,
    linux: bool,
    appimage: bool,
    macos: bool,
    in_app_bundle: bool,
}

/// Why this copy of the app cannot replace itself, if it cannot. A development build has nothing
/// to replace; on Linux only an AppImage can (a `.deb` or `.rpm` belongs to the package manager);
/// and on macOS only the app, since a bare binary (Homebrew's formula, `cargo install`) is not one.
fn cannot_update_itself(install: &Install) -> Option<&'static str> {
    if install.debug_build {
        Some("a development build")
    } else if install.linux && !install.appimage {
        Some("installed by a package manager")
    } else if install.macos && !install.in_app_bundle {
        Some("not run from an app bundle")
    } else {
        None
    }
}

fn running_in_app_bundle() -> bool {
    std::env::current_exe().ok().is_some_and(|exe| {
        exe.components()
            .any(|part| part.as_os_str().to_string_lossy().ends_with(".app"))
    })
}

fn unsupported() -> Option<&'static str> {
    cannot_update_itself(&Install {
        debug_build: cfg!(debug_assertions),
        linux: cfg!(target_os = "linux"),
        appimage: std::env::var_os("APPIMAGE").is_some(),
        macos: cfg!(target_os = "macos"),
        in_app_bundle: running_in_app_bundle(),
    })
}

fn info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        current: update.current_version.clone(),
        notes: update
            .body
            .as_ref()
            .map(|notes| notes.trim().to_string())
            .filter(|notes| !notes.is_empty()),
    }
}

/// The newer release there is, if any. `None` also when this copy cannot update itself.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> std::result::Result<Option<UpdateInfo>, String> {
    if unsupported().is_some() {
        return Ok(None);
    }
    let found = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let result = found.as_ref().map(info);
    *pending.0.lock() = found;
    Ok(result)
}

/// Downloads the update found by [`update_check`], installs it and restarts the app. Progress goes
/// out as `update://progress`. It returns only when something failed, and a failed install can be
/// tried again.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> std::result::Result<(), String> {
    let update = pending
        .0
        .lock()
        .clone()
        .ok_or_else(|| "there is no update to install; check again".to_string())?;
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit("update://progress", UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    // The exit handler stops the agents and the terminals on the way out.
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install() -> Install {
        Install {
            debug_build: false,
            linux: false,
            appimage: false,
            macos: false,
            in_app_bundle: false,
        }
    }

    #[test]
    fn a_development_build_does_not_update_itself() {
        let dev = Install {
            debug_build: true,
            ..install()
        };
        assert!(cannot_update_itself(&dev).is_some());
        let dev_appimage = Install {
            debug_build: true,
            linux: true,
            appimage: true,
            ..install()
        };
        assert!(cannot_update_itself(&dev_appimage).is_some());
    }

    #[test]
    fn on_linux_only_an_appimage_updates_itself() {
        let packaged = Install {
            linux: true,
            ..install()
        };
        assert!(cannot_update_itself(&packaged).is_some());
        let appimage = Install {
            linux: true,
            appimage: true,
            ..install()
        };
        assert_eq!(cannot_update_itself(&appimage), None);
    }

    #[test]
    fn on_macos_only_the_app_updates_itself() {
        let bare = Install {
            macos: true,
            ..install()
        };
        assert!(cannot_update_itself(&bare).is_some());
        let app = Install {
            macos: true,
            in_app_bundle: true,
            ..install()
        };
        assert_eq!(cannot_update_itself(&app), None);
    }

    #[test]
    fn a_windows_install_updates_itself() {
        assert_eq!(cannot_update_itself(&install()), None);
    }

    #[test]
    fn progress_is_sent_in_the_shape_the_window_reads() {
        let json = serde_json::to_value(UpdateProgress {
            downloaded: 10,
            total: None,
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "downloaded": 10, "total": null }));
    }

    // The path a release takes to a running app, without installing anything: the app asks a
    // manifest which release is newest, downloads the package and checks its signature against a key.
    mod release_path {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::path::PathBuf;

        use serde_json::json;
        use tauri::test::{mock_builder, mock_context, noop_assets};
        use tauri_plugin_updater::UpdaterExt;

        fn fixture(name: &str) -> PathBuf {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/updater")
                .join(name)
        }

        /// The target key the updater looks the platform up by.
        fn platform() -> String {
            let os = match std::env::consts::OS {
                "macos" => "darwin",
                other => other,
            };
            format!("{os}-{}", std::env::consts::ARCH)
        }

        /// Serves the manifest and the package, the package as the bytes given.
        fn serve(signature: String, package: Vec<u8>) -> String {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let manifest = json!({
                "version": "9.9.9",
                "notes": "A newer one.",
                "pub_date": "2026-01-01T00:00:00Z",
                "platforms": {
                    platform(): { "signature": signature, "url": format!("{base}/package") }
                }
            })
            .to_string();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let mut stream = stream;
                    let mut buffer = [0u8; 2048];
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..read]);
                    let body: Vec<u8> = if request.starts_with("GET /latest.json") {
                        manifest.clone().into_bytes()
                    } else {
                        package.clone()
                    };
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&body);
                }
            });
            base
        }

        async fn download(base: &str) -> tauri_plugin_updater::Result<Vec<u8>> {
            let pubkey = std::fs::read_to_string(fixture("test.key.pub")).unwrap();
            let mut context = mock_context(noop_assets());
            context.config_mut().plugins.0.insert(
                "updater".into(),
                json!({
                    "pubkey": pubkey.trim(),
                    "endpoints": [format!("{base}/latest.json")],
                    "dangerousInsecureTransportProtocol": true
                }),
            );
            let app = mock_builder()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .build(context)
                .unwrap();
            let update = app
                .handle()
                .updater()
                .unwrap()
                .check()
                .await?
                .expect("the manifest names a newer version");
            assert_eq!(update.version, "9.9.9");
            assert_eq!(update.body.as_deref(), Some("A newer one."));
            update.download(|_, _| {}, || {}).await
        }

        /// A tarball laid out the way `scripts/collect-release-files.sh` makes the app's: the
        /// `.app` folder is its root.
        #[cfg(target_os = "macos")]
        fn app_tarball(parent: &std::path::Path, name: &str) -> Vec<u8> {
            let out = parent.join("app.tar.gz");
            let status = std::process::Command::new("tar")
                .env("COPYFILE_DISABLE", "1")
                .arg("-C")
                .arg(parent)
                .arg("-czf")
                .arg(&out)
                .arg(name)
                .status()
                .unwrap();
            assert!(status.success());
            std::fs::read(out).unwrap()
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn installing_replaces_the_app_where_it_is() {
            let dir = tempfile::tempdir().unwrap();
            let make = |root: &str, version: &str| {
                let macos = dir.path().join(root).join("Ataraxia.app/Contents/MacOS");
                std::fs::create_dir_all(&macos).unwrap();
                std::fs::write(macos.join("ataraxia"), version).unwrap();
            };
            // The installed app, and the release's, which is what the tarball carries.
            make("installed", "old");
            make("release", "new");
            let release = dir.path().join("release");
            let tarball = app_tarball(&release, "Ataraxia.app");
            let installed_exe = dir
                .path()
                .join("installed/Ataraxia.app/Contents/MacOS/ataraxia");

            let signature = std::fs::read_to_string(fixture("payload.bin.sig")).unwrap();
            let base = serve(signature.trim().to_string(), Vec::new());
            let pubkey = std::fs::read_to_string(fixture("test.key.pub")).unwrap();
            let mut context = mock_context(noop_assets());
            context.config_mut().plugins.0.insert(
                "updater".into(),
                json!({
                    "pubkey": pubkey.trim(),
                    "endpoints": [format!("{base}/latest.json")],
                    "dangerousInsecureTransportProtocol": true
                }),
            );
            let app = mock_builder()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .build(context)
                .unwrap();
            let update = tauri::async_runtime::block_on(async {
                app.handle()
                    .updater_builder()
                    .executable_path(&installed_exe)
                    .build()
                    .unwrap()
                    .check()
                    .await
                    .unwrap()
                    .expect("a newer version")
            });
            update.install(&tarball).expect("install");
            assert_eq!(std::fs::read_to_string(&installed_exe).unwrap(), "new");
            assert!(dir.path().join("installed/Ataraxia.app").is_dir());
        }

        #[test]
        fn a_signed_package_is_downloaded_and_verified() {
            let package = std::fs::read(fixture("payload.bin")).unwrap();
            let signature = std::fs::read_to_string(fixture("payload.bin.sig")).unwrap();
            let base = serve(signature.trim().to_string(), package.clone());
            let bytes = tauri::async_runtime::block_on(download(&base)).expect("verified download");
            assert_eq!(bytes, package);
        }

        #[test]
        fn a_package_that_is_not_the_signed_one_is_refused() {
            let signature = std::fs::read_to_string(fixture("payload.bin.sig")).unwrap();
            let base = serve(signature.trim().to_string(), b"tampered payload".to_vec());
            let outcome = tauri::async_runtime::block_on(download(&base));
            assert!(
                outcome.is_err(),
                "a package that does not match its signature was accepted"
            );
        }
    }

    #[test]
    fn the_key_the_app_trusts_is_a_minisign_public_key() {
        use base64::Engine;
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        let pubkey = updater["pubkey"].as_str().expect("a public key");
        let text = base64::engine::general_purpose::STANDARD
            .decode(pubkey)
            .expect("the key is base64");
        assert!(
            String::from_utf8_lossy(&text).starts_with("untrusted comment: minisign public key"),
            "not a minisign public key"
        );
        // Only a signed release from this repository is trusted, over https.
        let endpoints = updater["endpoints"].as_array().unwrap();
        assert!(endpoints.iter().all(|endpoint| {
            endpoint
                .as_str()
                .is_some_and(|url| url.starts_with("https://github.com/myrk-kale/ataraxia/"))
        }));
    }
}
