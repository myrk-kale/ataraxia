//! Attachments owned by a chat. Documents include the original and harness-readable page files.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use uuid::Uuid;

use crate::domain::ids::SessionId;
use crate::domain::image::decode_uploads;
use crate::domain::{Error, ErrorCode, ImageAttachment, ImageUpload, Result};

const FORMATS: [(&str, &str); 8] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("text/html", "html"),
    ("text/markdown", "md"),
    ("application/pdf", "pdf"),
    (crate::domain::document::DOCX_MIME, "docx"),
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
        std::fs::write(&path, &image.bytes)
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        let harness_path = if image.mime.starts_with("image/") {
            path.clone()
        } else {
            let pages = dir.join(&id);
            if let Err(error) = prepare_document(&pages, &path, image.mime, &image.bytes) {
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_dir_all(&pages);
                for previous in &stored {
                    let previous: &StoredImage = previous;
                    let _ = std::fs::remove_file(dir.join(format!(
                        "{}.{}",
                        previous.attachment.id,
                        extension(&previous.attachment.mime)
                    )));
                    let _ = std::fs::remove_dir_all(dir.join(&previous.attachment.id));
                }
                return Err(error);
            }
            pages
        };
        stored.push(StoredImage {
            attachment: ImageAttachment {
                id,
                name: image.name,
                mime: image.mime.to_string(),
            },
            path: harness_path,
        });
    }
    Ok(stored)
}

fn prepare_document(dir: &Path, original: &Path, mime: &str, bytes: &[u8]) -> Result<()> {
    use crate::domain::document;
    let io = |error: std::io::Error| Error::new(ErrorCode::Io, error.to_string());
    std::fs::create_dir_all(dir).map_err(io)?;
    let note = match mime {
        "application/pdf" => {
            let pdf = document::pdf(bytes)?;
            let numbers: Vec<_> = pdf.get_pages().keys().copied().collect();
            let mut remaining = 100 * 1024 * 1024;
            for number in &numbers {
                let mut page = pdf.clone();
                page.delete_pages(
                    &numbers
                        .iter()
                        .copied()
                        .filter(|n| n != number)
                        .collect::<Vec<_>>(),
                );
                page.prune_objects();
                let file =
                    std::fs::File::create(dir.join(format!("page-{number:04}.pdf"))).map_err(io)?;
                let mut writer = LimitedWriter { file, remaining };
                page.save_to(&mut writer).map_err(io)?;
                remaining = writer.remaining;
            }
            format!(
                "{} pages. Each page-XXXX.pdf preserves that page's content.\n",
                numbers.len()
            )
        }
        document::DOCX_MIME => {
            let pages = document::docx_pages(bytes)?;
            for (index, page) in pages.iter().enumerate() {
                std::fs::write(dir.join(format!("page-{:04}.txt", index + 1)), page).map_err(io)?;
            }
            format!(
                "{} text sections, split at explicit Word page breaks. These are not rendered pages. Tables are plain text; images and formatting remain in the original DOCX.\n",
                pages.len()
            )
        }
        _ => {
            std::fs::write(dir.join(format!("document.{}", extension(mime))), bytes).map_err(io)?;
            "Single text document; no fixed page layout.\n".to_string()
        }
    };
    std::fs::write(
        dir.join("README.txt"),
        format!("Original file: {}\n{note}", original.display()),
    )
    .map_err(io)?;
    Ok(())
}

/// Shared PDF resources can otherwise be duplicated into hundreds of large page files.
struct LimitedWriter {
    file: std::fs::File,
    remaining: usize,
}

impl std::io::Write for LimitedWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(std::io::Error::other(
                "PDF page files exceed the 100 MB expansion limit",
            ));
        }
        let written = std::io::Write::write(&mut self.file, bytes)?;
        self.remaining -= written;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        std::io::Write::flush(&mut self.file)
    }
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

    fn pdf_upload(pages: usize) -> ImageUpload {
        use lopdf::{Document, Object, dictionary};
        let mut pdf = Document::with_version("1.5");
        let tree = pdf.new_object_id();
        let mut kids = Vec::new();
        for index in 0..pages {
            let content = pdf.add_object(lopdf::Stream::new(
                dictionary! {},
                format!("% page {}", index + 1).into_bytes(),
            ));
            let page = pdf.add_object(dictionary! {
                "Type" => "Page", "Parent" => tree, "Contents" => content,
                "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            });
            kids.push(Object::Reference(page));
        }
        pdf.objects.insert(
            tree,
            dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => pages as i64 }.into(),
        );
        let catalog = pdf.add_object(dictionary! { "Type" => "Catalog", "Pages" => tree });
        pdf.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        pdf.save_to(&mut bytes).unwrap();
        upload("report.pdf", &bytes)
    }

    #[test]
    fn pdf_pages_preserve_content_and_original_is_available_by_id() {
        let root = root();
        let session = SessionId::new();
        let stored = store(&root, &session, &[pdf_upload(2)]).unwrap();
        let folder = &stored[0].path;
        assert!(folder.is_dir());
        for number in 1..=2 {
            let page = lopdf::Document::load(folder.join(format!("page-{number:04}.pdf"))).unwrap();
            let pages = page.get_pages();
            assert_eq!(pages.len(), 1);
            assert_eq!(
                String::from_utf8(
                    page.get_page_content(*pages.values().next().unwrap())
                        .unwrap()
                )
                .unwrap()
                .trim(),
                format!("% page {number}")
            );
        }
        assert!(
            std::fs::read_to_string(folder.join("README.txt"))
                .unwrap()
                .contains("2 pages")
        );
        assert!(
            data_url(&root, &session, &stored[0].attachment.id)
                .unwrap()
                .starts_with("data:application/pdf;base64,")
        );
        forget(&root, &session);
        assert!(!folder.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_documents_reject_the_batch_before_writing() {
        let root = root();
        let session = SessionId::new();
        for bad in [
            upload("bad.pdf", b"%PDF-broken"),
            upload("bad.docx", b"PK\x03\x04broken"),
            upload("binary.md", b"\0\xff"),
        ] {
            assert!(store(&root, &session, &[upload("ok.md", b"# hello"), bad]).is_err());
            assert!(!root.exists());
        }
        assert!(
            store(
                &root,
                &session,
                &[pdf_upload(crate::domain::document::MAX_PAGES + 1)]
            )
            .is_err()
        );
        assert!(!root.exists());
    }

    #[test]
    fn text_documents_keep_content_without_executing_html() {
        let root = root();
        let session = SessionId::new();
        let html = b"<script>alert('hello')</script>";
        let stored = store(
            &root,
            &session,
            &[upload("../../a.html", html), upload("notes.md", b"# notes")],
        )
        .unwrap();
        assert_eq!(stored[0].attachment.name, "a.html");
        assert_eq!(
            std::fs::read(stored[0].path.join("document.html")).unwrap(),
            html
        );
        assert_eq!(
            std::fs::read(stored[1].path.join("document.md")).unwrap(),
            b"# notes"
        );
        forget(&root, &session);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn docx_explicit_breaks_become_text_pages_and_archive_paths_are_not_extracted() {
        use std::io::{Cursor, Write};
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive.write_all(br#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>first &amp; one</w:t><w:br w:type="page"/><w:t>second</w:t></w:r></w:p></w:body></w:document>"#).unwrap();
        archive
            .start_file("../../escape.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"do not extract").unwrap();
        let bytes = archive.finish().unwrap().into_inner();
        let root = root();
        let session = SessionId::new();
        let stored = store(&root, &session, &[upload("report.docx", &bytes)]).unwrap();
        assert_eq!(
            std::fs::read_to_string(stored[0].path.join("page-0001.txt")).unwrap(),
            "first & one"
        );
        assert_eq!(
            std::fs::read_to_string(stored[0].path.join("page-0002.txt")).unwrap(),
            "second\n"
        );
        assert!(!root.join("escape.txt").exists());
        forget(&root, &session);
        let _ = std::fs::remove_dir_all(root);
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
