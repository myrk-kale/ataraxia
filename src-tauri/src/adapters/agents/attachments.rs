//! Images attached to messages: checked, kept as files the app owns, and read back by id.
//!
//! The window sends bytes; what is stored is judged by the bytes, not by the name or the type the
//! sender claimed. Only a few picture formats are taken for now.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use uuid::Uuid;

use crate::domain::ids::SessionId;
use crate::domain::image::decode_uploads;
use crate::domain::{Error, ErrorCode, ImageAttachment, ImageUpload, Result};

const FORMATS: [(&str, &str); 4] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
];

/// An image on disk, as an agent is given it.
#[derive(Debug, Clone)]
pub struct StoredImage {
    pub attachment: ImageAttachment,
    pub path: PathBuf,
}

fn extension(mime: &str) -> &'static str {
    FORMATS
        .iter()
        .find(|(known, _)| *known == mime)
        .map_or("bin", |(_, ext)| ext)
}

fn session_dir(root: &Path, session: &SessionId) -> PathBuf {
    root.join(session.0.to_string())
}

/// Checks the uploads and writes them under `root/<session>/`.
pub fn store(
    root: &Path,
    session: &SessionId,
    uploads: &[ImageUpload],
) -> Result<Vec<StoredImage>> {
    let decoded = decode_uploads(uploads)?;
    if decoded.is_empty() {
        return Ok(Vec::new());
    }
    let dir = session_dir(root, session);
    std::fs::create_dir_all(&dir).map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    let mut stored = Vec::new();
    for image in decoded {
        let id = Uuid::new_v4().simple().to_string();
        let path = dir.join(format!("{id}.{}", extension(image.mime)));
        std::fs::write(&path, image.bytes)
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        stored.push(StoredImage {
            attachment: ImageAttachment {
                id,
                name: image.name,
                mime: image.mime.to_string(),
            },
            path,
        });
    }
    Ok(stored)
}

/// Where a stored image is, by its id. Ids are plain hex, so nothing outside the folder is reachable.
pub fn locate(root: &Path, session: &SessionId, id: &str) -> Result<(PathBuf, &'static str)> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::new(ErrorCode::NotFound, "image not found"));
    }
    let dir = session_dir(root, session);
    FORMATS
        .iter()
        .map(|(mime, ext)| (dir.join(format!("{id}.{ext}")), *mime))
        .find(|(path, _)| path.is_file())
        .ok_or_else(|| Error::new(ErrorCode::NotFound, "image not found"))
}

/// A stored image as a `data:` URL, which the window can show without any file access.
pub fn data_url(root: &Path, session: &SessionId, id: &str) -> Result<String> {
    let (path, mime) = locate(root, session, id)?;
    let bytes =
        std::fs::read(path).map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Removes everything a chat attached.
pub fn forget(root: &Path, session: &SessionId) {
    let _ = std::fs::remove_dir_all(session_dir(root, session));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::image::{MAX_IMAGE_BYTES, MAX_IMAGES, sniff};

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

    fn upload(name: &str, bytes: &[u8]) -> ImageUpload {
        ImageUpload {
            name: name.into(),
            mime: "image/png".into(),
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        }
    }

    fn root() -> PathBuf {
        std::env::temp_dir().join(format!("ataraxia-attach-{}", Uuid::new_v4()))
    }

    #[test]
    fn images_are_judged_by_their_bytes() {
        assert_eq!(sniff(PNG), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a.."), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"<svg xmlns='http://www.w3.org/2000/svg'/>"), None);
        assert_eq!(sniff(b"#!/bin/sh\n"), None);
    }

    #[test]
    fn a_stored_image_is_read_back_by_id_and_forgotten_with_its_chat() {
        let root = root();
        let session = SessionId::new();
        let stored = store(&root, &session, &[upload("../../etc/shot one.png", PNG)]).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(
            stored[0].attachment.name, "shot one.png",
            "no folders in a name"
        );
        assert_eq!(stored[0].attachment.mime, "image/png");
        assert!(stored[0].path.starts_with(&root));
        let url = data_url(&root, &session, &stored[0].attachment.id).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        // Another chat cannot read it, and an id cannot name a path.
        assert!(data_url(&root, &SessionId::new(), &stored[0].attachment.id).is_err());
        assert!(data_url(&root, &session, "../x").is_err());
        forget(&root, &session);
        assert!(data_url(&root, &session, &stored[0].attachment.id).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn what_is_not_a_picture_or_is_too_much_is_refused_and_nothing_is_written() {
        let root = root();
        let session = SessionId::new();
        let svg = upload("a.png", b"<svg onload='x()'/>");
        let refused = store(&root, &session, &[upload("ok.png", PNG), svg]).unwrap_err();
        assert!(refused.message.contains("not a PNG"), "{}", refused.message);
        assert!(
            !root.exists(),
            "an image is not kept when another is refused"
        );

        let broken = ImageUpload {
            name: "b.png".into(),
            mime: "image/png".into(),
            data: "%%%".into(),
        };
        assert!(store(&root, &session, &[broken]).is_err());
        let big = vec![0x89u8; MAX_IMAGE_BYTES + 1];
        assert!(store(&root, &session, &[upload("big.png", &big)]).is_err());
        let many: Vec<_> = (0..=MAX_IMAGES).map(|_| upload("a.png", PNG)).collect();
        assert!(store(&root, &session, &many).is_err());
        assert!(store(&root, &session, &[]).unwrap().is_empty());
    }
}
