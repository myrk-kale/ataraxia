use std::io::{Cursor, Read};

use super::{Error, ErrorCode, Result};

pub const MAX_DOCUMENT_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_PAGES: usize = 200;
const MAX_XML_BYTES: u64 = 32 * 1024 * 1024;
pub const DOCX_MIME: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

fn invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorCode::Invalid, message)
}

pub fn mime(name: &str, bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"%PDF-") {
        return Some("application/pdf");
    }
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "docx" if bytes.starts_with(b"PK\x03\x04") => Some(DOCX_MIME),
        "md" | "markdown" => Some("text/markdown"),
        "html" | "htm" => Some("text/html"),
        _ => super::office::mime(name, bytes),
    }
}

pub fn pdf(bytes: &[u8]) -> Result<lopdf::Document> {
    let document = lopdf::Document::load_mem(bytes)
        .map_err(|_| invalid("PDF could not be read (invalid or encrypted document)"))?;
    let pages = document.get_pages().len();
    if document.is_encrypted() || pages == 0 || pages > MAX_PAGES {
        return Err(invalid(format!(
            "PDF must be unencrypted and have 1 to {MAX_PAGES} pages"
        )));
    }
    Ok(document)
}

/// Word's explicit page breaks only; layout pagination requires a Word-compatible renderer.
pub fn docx_pages(bytes: &[u8]) -> Result<Vec<String>> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| invalid("invalid DOCX archive"))?;
    let xml = archive
        .by_name("word/document.xml")
        .map_err(|_| invalid("DOCX has no word/document.xml"))?;
    if xml.size() > MAX_XML_BYTES {
        return Err(invalid("DOCX document XML is too large"));
    }
    let mut data = Vec::new();
    xml.take(MAX_XML_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|_| invalid("DOCX document XML could not be read"))?;
    if data.len() as u64 > MAX_XML_BYTES {
        return Err(invalid("DOCX document XML is too large"));
    }
    let mut reader = quick_xml::Reader::from_reader(data.as_slice());
    let mut pages = vec![String::new()];
    let mut in_text = false;
    let mut saw_document = false;
    let mut depth = 0usize;
    loop {
        use quick_xml::events::Event;
        match reader
            .read_event()
            .map_err(|_| invalid("invalid DOCX XML"))?
        {
            Event::Eof => break,
            Event::DocType(_) => return Err(invalid("DOCX XML must not contain a DTD")),
            Event::Start(e) if e.local_name().as_ref() == b"document" && depth == 0 => {
                saw_document = true;
                depth += 1;
            }
            Event::Start(e) if e.local_name().as_ref() == b"t" => {
                in_text = true;
                depth += 1;
            }
            Event::End(e) if e.local_name().as_ref() == b"t" => {
                in_text = false;
                depth = depth.saturating_sub(1);
            }
            Event::End(e) if e.local_name().as_ref() == b"p" => {
                depth = depth.saturating_sub(1);
                pages.last_mut().unwrap().push('\n')
            }
            Event::Start(_) => {
                depth += 1;
            }
            Event::End(_) => {
                depth = depth.saturating_sub(1);
            }
            Event::Empty(e) if e.local_name().as_ref() == b"br" => {
                let page = e.attributes().any(|a| {
                    a.is_ok_and(|a| {
                        a.key.local_name().as_ref() == b"type" && a.value.as_ref() == b"page"
                    })
                });
                if page {
                    if pages.len() >= MAX_PAGES {
                        return Err(invalid("DOCX has too many page breaks"));
                    }
                    pages.push(String::new());
                } else {
                    pages.last_mut().unwrap().push('\n');
                }
            }
            Event::Empty(e) if e.local_name().as_ref() == b"tab" => {
                pages.last_mut().unwrap().push('\t')
            }
            Event::Text(e) if in_text => {
                let value = e.decode().map_err(|_| invalid("invalid DOCX text"))?;
                pages.last_mut().unwrap().push_str(&value);
            }
            Event::GeneralRef(e) if in_text => {
                let value = e.decode().map_err(|_| invalid("invalid DOCX reference"))?;
                let reference = format!("&{value};");
                let decoded = quick_xml::escape::unescape(&reference)
                    .map_err(|_| invalid("invalid DOCX reference"))?;
                pages.last_mut().unwrap().push_str(&decoded);
            }
            _ => {}
        }
    }
    if !saw_document || depth != 0 {
        return Err(invalid("DOCX XML has no complete document element"));
    }
    Ok(pages)
}

pub fn validate(mime: &str, bytes: &[u8]) -> Result<()> {
    match mime {
        "application/pdf" => {
            pdf(bytes)?;
        }
        DOCX_MIME => {
            docx_pages(bytes)?;
        }
        _ => {
            let text =
                std::str::from_utf8(bytes).map_err(|_| invalid("text documents must use UTF-8"))?;
            if text.contains('\0') {
                return Err(invalid("text document contains binary data"));
            }
        }
    }
    Ok(())
}
