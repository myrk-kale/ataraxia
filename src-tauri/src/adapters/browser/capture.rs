//! A picture of a webview.
//!
//! WebKit can photograph its own view (`takeSnapshot`), so on macOS the picture is the page as drawn,
//! whether or not the view is on screen. Elsewhere the platform has no call for it and the browser
//! says so, which an agent can work around with a snapshot of the page's text.

use crate::domain::browser::Rect;
use crate::domain::{Error, ErrorCode, Result};

#[cfg(target_os = "macos")]
pub fn png(webview: &tauri::Webview, clip: Option<Rect>) -> Result<Vec<u8>> {
    use std::sync::mpsc;
    use std::time::Duration;

    let (sender, receiver) = mpsc::channel::<Result<Vec<u8>>>();
    webview
        .with_webview(move |platform| {
            // SAFETY: the pointer is the page's WKWebView, and this runs on the main thread, where
            // WebKit wants to be called, while the webview is alive.
            let view = platform.inner();
            let outcome = unsafe { macos::snapshot(view, clip, sender.clone()) };
            if let Err(error) = outcome {
                let _ = sender.send(Err(error));
            }
        })
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    receiver
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| {
            Error::new(
                ErrorCode::Agent,
                "the page took too long to be photographed",
            )
        })?
}

#[cfg(not(target_os = "macos"))]
pub fn png(_webview: &tauri::Webview, _clip: Option<Rect>) -> Result<Vec<u8>> {
    Err(Error::new(
        ErrorCode::Unsupported,
        "screenshots are not available on this platform yet: use browser_snapshot to read the page",
    ))
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::sync::mpsc::Sender;

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSNumber, NSPoint, NSRect, NSSize};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    use super::Rect;
    use crate::domain::{Error, ErrorCode, Result};

    fn io(message: &str) -> Error {
        Error::new(ErrorCode::Io, message)
    }

    /// Asks WebKit for the picture; the answer is sent on `sender` when it is ready.
    ///
    /// # Safety
    /// `view` must be a live `WKWebView`, and this must run on the main thread.
    pub unsafe fn snapshot(
        view: *mut c_void,
        clip: Option<Rect>,
        sender: Sender<Result<Vec<u8>>>,
    ) -> Result<()> {
        let view: &WKWebView = unsafe { (view as *mut WKWebView).as_ref() }
            .ok_or_else(|| io("the page has no view"))?;
        let main = MainThreadMarker::new().ok_or_else(|| io("not on the main thread"))?;
        let config = unsafe { WKSnapshotConfiguration::new(main) };
        unsafe {
            if let Some(rect) = clip {
                config.setRect(NSRect::new(
                    NSPoint::new(rect.x, rect.y),
                    NSSize::new(rect.width, rect.height),
                ));
                // One pixel per point: a retina picture of a small element is no more use to a reader.
                config.setSnapshotWidth(Some(&NSNumber::new_f64(rect.width)));
            } else {
                let width = view.frame().size.width;
                config.setSnapshotWidth(Some(&NSNumber::new_f64(width)));
            }
        }
        let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let reply = if image.is_null() {
                let reason = unsafe { error.as_ref() }
                    .map(|error| error.localizedDescription().to_string())
                    .unwrap_or_else(|| "no picture".into());
                Err(Error::new(
                    ErrorCode::Io,
                    format!("WebKit could not photograph the page: {reason}"),
                ))
            } else {
                let image: Retained<NSImage> =
                    unsafe { Retained::retain(image) }.expect("not null");
                encode(&image)
            };
            let _ = sender.send(reply);
        });
        unsafe { view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block) };
        Ok(())
    }

    fn encode(image: &NSImage) -> Result<Vec<u8>> {
        let tiff = image
            .TIFFRepresentation()
            .ok_or_else(|| io("the picture could not be read"))?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)
            .ok_or_else(|| io("the picture could not be read"))?;
        let properties: Retained<NSDictionary<_, _>> = NSDictionary::new();
        let png = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        }
        .ok_or_else(|| io("the picture could not be made a PNG"))?;
        Ok(png.to_vec())
    }
}
