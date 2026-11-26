//! The built-in browser on the platform's webviews (Tauri's multiwebview).
//!
//! Each tab is a child webview of the main window, drawn over the place the window's browser view
//! occupies. A tab the developer is not looking at is moved out of sight but kept at its size, so it
//! goes on rendering and can still be photographed. Pages get the bridge (`agent.js`) before their
//! own scripts run; remote pages have no way to reach the app's commands, because the window's
//! capability names no remote address.

use std::sync::mpsc;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

use crate::domain::browser::{BrowserEvent, Placement, Profile, Rect, TabId};
use crate::domain::{Error, ErrorCode, Result};
use crate::ports::{BrowserEngine, CookieInfo, EngineEvents, TabSpec};

mod capture;
pub mod shrink;

/// The bridge injected into every page.
pub const BRIDGE: &str = include_str!("agent.js");
pub const EVENT: &str = "browser://event";

/// Where a parked page waits: far enough left that none of it shows.
const PARKED_X: f64 = -20_000.0;

fn label(id: TabId) -> String {
    format!("browser-{id}")
}

fn io(message: impl ToString) -> Error {
    Error::new(ErrorCode::Io, message.to_string())
}

pub struct TauriEngine {
    app: AppHandle,
    events: Arc<OnceLock<Arc<dyn EngineEvents>>>,
    profiles: Mutex<std::collections::HashMap<TabId, Profile>>,
    /// The address of the app's own development server, which a page must never reach: to the
    /// platform it is a local origin, with the powers of the app.
    dev_origin: Option<String>,
}

impl TauriEngine {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let dev_origin = app
            .config()
            .build
            .dev_url
            .as_ref()
            .map(|url| origin_of(url.as_str()));
        Arc::new(Self {
            app,
            events: Arc::new(OnceLock::new()),
            profiles: Mutex::new(std::collections::HashMap::new()),
            dev_origin,
        })
    }

    /// Where the platform's reports about pages go.
    pub fn set_events(&self, events: Arc<dyn EngineEvents>) {
        let _ = self.events.set(events);
    }

    pub fn emit(app: &AppHandle) -> Arc<dyn Fn(BrowserEvent) + Send + Sync> {
        let app = app.clone();
        Arc::new(move |event| {
            let _ = app.emit(EVENT, event);
        })
    }

    fn webview(&self, id: TabId) -> Result<tauri::Webview> {
        self.app
            .get_webview(&label(id))
            .ok_or_else(|| Error::new(ErrorCode::NotFound, format!("tab {id} has no page")))
    }
}

/// `scheme://host:port` of an address, or the address itself when it has none.
fn origin_of(url: &str) -> String {
    url::Url::parse(url).map_or_else(
        |_| url.to_string(),
        |parsed| parsed.origin().ascii_serialization(),
    )
}

/// Addresses no page may be taken to, whatever the page or the developer says: the app's own.
fn is_app_address(url: &url::Url, dev_origin: Option<&str>) -> bool {
    let host = url.host_str().unwrap_or("");
    matches!(url.scheme(), "tauri" | "ipc" | "asset" | "devtools")
        || host == "tauri.localhost"
        || host == "ipc.localhost"
        || host == "asset.localhost"
        || dev_origin.is_some_and(|origin| url.origin().ascii_serialization() == origin)
}

/// A store of cookies and site data per profile. macOS keeps them in a data store with an
/// identifier; elsewhere in a folder of their own.
fn profile_store(profile: Profile) -> [u8; 16] {
    match profile {
        Profile::User => *b"ataraxia-browser",
        Profile::Agent => *b"ataraxia-agent-b",
    }
}

impl BrowserEngine for TauriEngine {
    fn create(&self, spec: &TabSpec) -> Result<()> {
        let window = self
            .app
            .get_window("main")
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "the app's window is not there"))?;
        let id = spec.id;
        let url: url::Url = spec
            .url
            .parse()
            .map_err(|error: url::ParseError| Error::new(ErrorCode::Invalid, error.to_string()))?;
        if is_app_address(&url, self.dev_origin.as_deref()) {
            return Err(Error::new(
                ErrorCode::Invalid,
                "that address is the app's own and is not opened here",
            ));
        }
        let events = Arc::clone(&self.events);
        let (nav_events, load_events, title_events, popup_events) = (
            Arc::clone(&events),
            Arc::clone(&events),
            Arc::clone(&events),
            Arc::clone(&events),
        );
        let dev_origin = self.dev_origin.clone();
        let mut builder = WebviewBuilder::new(label(id), WebviewUrl::External(url))
            .initialization_script(BRIDGE)
            .devtools(true)
            .disable_drag_drop_handler()
            .on_navigation(move |target| {
                if is_app_address(target, dev_origin.as_deref()) {
                    return false;
                }
                nav_events
                    .get()
                    .is_none_or(|events| events.navigating(id, target.as_str()))
            })
            .on_page_load(move |_, payload| {
                if let Some(events) = load_events.get() {
                    events.page_load(
                        id,
                        payload.url().as_str(),
                        matches!(payload.event(), PageLoadEvent::Finished),
                    );
                }
            })
            .on_document_title_changed(move |_, title| {
                if let Some(events) = title_events.get() {
                    events.title(id, &title);
                }
            })
            .on_new_window(move |target, _| {
                if let Some(events) = popup_events.get() {
                    events.popup(id, target.as_str());
                }
                NewWindowResponse::Deny
            });
        #[cfg(target_os = "macos")]
        {
            builder = builder.data_store_identifier(profile_store(spec.profile));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let folder = self
                .app
                .path()
                .app_data_dir()
                .map_err(io)?
                .join("browser")
                .join(match spec.profile {
                    Profile::User => "user",
                    Profile::Agent => "agent",
                });
            builder = builder.data_directory(folder);
        }
        let (position, size) = geometry(spec.placement);
        window.add_child(builder, position, size).map_err(io)?;
        self.profiles.lock().insert(id, spec.profile);
        Ok(())
    }

    fn close(&self, id: TabId) -> Result<()> {
        self.profiles.lock().remove(&id);
        self.webview(id)?.close().map_err(io)
    }

    fn navigate(&self, id: TabId, url: &str) -> Result<()> {
        let parsed: url::Url = url
            .parse()
            .map_err(|error: url::ParseError| Error::new(ErrorCode::Invalid, error.to_string()))?;
        if is_app_address(&parsed, self.dev_origin.as_deref()) {
            return Err(Error::new(
                ErrorCode::Invalid,
                "that address is the app's own and is not opened here",
            ));
        }
        self.webview(id)?.navigate(parsed).map_err(io)
    }

    fn place(&self, id: TabId, placement: Placement) -> Result<()> {
        let (position, size) = geometry(placement);
        let webview = self.webview(id)?;
        webview
            .set_bounds(tauri::Rect {
                position: position.into(),
                size: size.into(),
            })
            .map_err(io)
    }

    fn eval(&self, id: TabId, script: &str, timeout: Duration) -> Result<String> {
        let webview = self.webview(id)?;
        let (sender, receiver) = mpsc::channel();
        webview
            .eval_with_callback(script.to_string(), move |answer| {
                let _ = sender.send(answer);
            })
            .map_err(io)?;
        receiver
            .recv_timeout(timeout)
            .map_err(|_| Error::new(ErrorCode::Agent, "the page did not answer in time"))
    }

    fn screenshot(&self, id: TabId, clip: Option<Rect>) -> Result<Vec<u8>> {
        let picture = capture::png(&self.webview(id)?, clip)?;
        // What an agent receives is no wider than a screen; a retina picture is twice the bytes
        // for no more to read.
        shrink::fit(&picture, shrink::MAX_WIDTH).or(Ok(picture))
    }

    fn devtools(&self, id: TabId) -> Result<()> {
        self.webview(id)?.open_devtools();
        Ok(())
    }

    fn cookies(&self, id: TabId, url: &str) -> Result<Vec<CookieInfo>> {
        let parsed: url::Url = url
            .parse()
            .map_err(|_| Error::new(ErrorCode::Invalid, "the tab has no address yet"))?;
        let cookies = self.webview(id)?.cookies_for_url(parsed).map_err(io)?;
        Ok(cookies
            .into_iter()
            .map(|cookie| CookieInfo {
                name: cookie.name().to_string(),
                value: cookie.value().to_string(),
                domain: cookie.domain().map(str::to_string),
                path: cookie.path().map(str::to_string),
                secure: cookie.secure().unwrap_or(false),
                http_only: cookie.http_only().unwrap_or(false),
                same_site: cookie.same_site().map(|same| same.to_string()),
                expires: cookie.expires_datetime().map(|time| time.to_string()),
            })
            .collect())
    }

    fn clear_data(&self, profile: Profile) -> Result<()> {
        let id = self
            .profiles
            .lock()
            .iter()
            .find(|(_, tab_profile)| **tab_profile == profile)
            .map(|(id, _)| *id)
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::Unsupported,
                    "open a tab of that profile first: its data is cleared through a page",
                )
            })?;
        self.webview(id)?.clear_all_browsing_data().map_err(io)
    }
}

fn geometry(placement: Placement) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    match placement {
        Placement::Visible(rect) => (
            LogicalPosition::new(rect.x, rect.y),
            LogicalSize::new(rect.width, rect.height),
        ),
        Placement::Parked { width, height } => (
            LogicalPosition::new(PARKED_X, 0.0),
            LogicalSize::new(width, height),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> url::Url {
        text.parse().unwrap()
    }

    #[test]
    fn the_apps_own_addresses_are_never_opened() {
        let dev = Some("http://localhost:1420");
        for refused in [
            "tauri://localhost/",
            "ipc://localhost/x",
            "asset://localhost/a",
            "https://tauri.localhost/",
            "http://ipc.localhost/x",
            "http://localhost:1420/",
            "http://localhost:1420/some/path?x=1",
        ] {
            assert!(is_app_address(&url(refused), dev), "{refused}");
        }
        for fine in [
            "https://example.com/",
            "http://localhost:3000/",
            "http://localhost:1421/",
            "http://127.0.0.1:1420/",
            "file:///tmp/a.html",
            "about:blank",
        ] {
            assert!(!is_app_address(&url(fine), dev), "{fine}");
        }
        assert!(
            !is_app_address(&url("http://localhost:1420/"), None),
            "with no development server there is nothing to guard"
        );
    }

    #[test]
    fn an_address_has_an_origin_to_compare() {
        assert_eq!(
            origin_of("http://localhost:1420/index.html"),
            "http://localhost:1420"
        );
        assert_eq!(origin_of("https://a.test"), "https://a.test");
    }

    #[test]
    fn the_two_profiles_have_stores_of_their_own() {
        assert_ne!(profile_store(Profile::User), profile_store(Profile::Agent));
        assert_eq!(profile_store(Profile::Agent).len(), 16);
    }

    #[test]
    fn a_page_in_view_is_where_the_view_is_and_a_parked_one_is_out_of_sight_at_the_same_size() {
        let (position, size) = geometry(Placement::Visible(Rect {
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 200.0,
        }));
        assert_eq!(
            (position.x, position.y, size.width, size.height),
            (10.0, 20.0, 300.0, 200.0)
        );
        let (position, size) = geometry(Placement::Parked {
            width: 300.0,
            height: 200.0,
        });
        assert!(position.x < -1000.0);
        assert_eq!((size.width, size.height), (300.0, 200.0));
    }

    #[test]
    fn the_bridge_is_shipped_with_the_app_and_installs_itself_once() {
        assert!(BRIDGE.contains("window.__ataraxia"));
        assert!(BRIDGE.contains("Object.freeze"));
        assert!(BRIDGE.len() > 10_000);
    }
}
