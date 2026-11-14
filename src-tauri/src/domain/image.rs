//! Pictures a user attaches: what is accepted, judged by the bytes and not by the name or the type
//! the sender claimed. Only a few picture formats are taken for now.

use base64::Engine as _;

use super::{Error, ErrorCode, ImageUpload, Result};

/// Images on one message.
pub const MAX_IMAGES: usize = 5;
/// One image, in bytes. The largest size the agents accept.
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

/// An upload that passed the checks.
#[derive(Debug, Clone)]
pub struct DecodedImage {
    pub name: String,
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

/// The format of a picture, from its first bytes.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// A file name that is safe to show and to put in a prompt: no folders, no control characters.
fn clean_name(name: &str, fallback: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// Checks every upload; all or none is accepted.
pub fn decode_uploads(uploads: &[ImageUpload]) -> Result<Vec<DecodedImage>> {
    if uploads.len() > MAX_IMAGES {
        return Err(Error::new(
            ErrorCode::Invalid,
            format!("at most {MAX_IMAGES} images go with one message"),
        ));
    }
    let mut decoded = Vec::new();
    for (index, upload) in uploads.iter().enumerate() {
        let name = clean_name(&upload.name, &format!("image {}", index + 1));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(upload.data.trim())
            .map_err(|_| {
                Error::new(
                    ErrorCode::Invalid,
                    format!("{name} is not valid image data"),
                )
            })?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(Error::new(
                ErrorCode::Invalid,
                format!("{name} is over {} MB", MAX_IMAGE_BYTES / 1024 / 1024),
            ));
        }
        let mime = sniff(&bytes).ok_or_else(|| {
            Error::new(
                ErrorCode::Invalid,
                format!("{name} is not a PNG, JPEG, GIF or WebP image"),
            )
        })?;
        decoded.push(DecodedImage { name, mime, bytes });
    }
    Ok(decoded)
}
