//! Attachment limits and validation. The legacy image wire format also carries documents.

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
            format!("at most {MAX_IMAGES} files go with one message"),
        ));
    }
    let mut decoded = Vec::new();
    for (index, upload) in uploads.iter().enumerate() {
        let name = clean_name(&upload.name, &format!("image {}", index + 1));
        if upload.data.len() > super::document::MAX_DOCUMENT_BYTES.div_ceil(3) * 4 {
            return Err(Error::new(
                ErrorCode::Invalid,
                format!("{name} is over 20 MB"),
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(upload.data.trim())
            .map_err(|_| {
                Error::new(ErrorCode::Invalid, format!("{name} is not valid file data"))
            })?;
        let image_mime = sniff(&bytes);
        let limit = if image_mime.is_some() {
            MAX_IMAGE_BYTES
        } else {
            super::document::MAX_DOCUMENT_BYTES
        };
        if bytes.len() > limit {
            return Err(Error::new(
                ErrorCode::Invalid,
                format!("{name} is over {} MB", limit / 1024 / 1024),
            ));
        }
        let mime = image_mime.or_else(|| super::document::mime(&upload.name, &bytes)).ok_or_else(|| {
            Error::new(
                ErrorCode::Invalid,
                format!("{name} is not a PNG, JPEG, GIF or WebP image, HTML, PDF, Markdown or DOCX document"),
            )
        })?;
        if image_mime.is_none() {
            super::document::validate(mime, &bytes)?;
        }
        decoded.push(DecodedImage { name, mime, bytes });
    }
    Ok(decoded)
}
