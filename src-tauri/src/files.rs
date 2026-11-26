//! A small file server on loopback, so a file an agent made can be shown in the chat and downloaded.
//!
//! The server never lists a folder and serves nothing it was not told to: a share is one file the
//! API vetted (inside the chat's own worktrees, see `api.rs`), given an unguessable id, and the id
//! in the address is the whole key. It is bound to `127.0.0.1`, answers only `GET` and `HEAD`, and
//! refuses a `Host` that is not itself (a page on the web cannot reach it by pointing its own name
//! at 127.0.0.1). Shares live as long as the app does; the file is read when it is asked for, so a
//! file that changed shows what it holds now and one that is gone answers 404.
//!
//! What a browser could do with what it receives is held back: every answer says `nosniff`, a page
//! that can run code (HTML, SVG, XML) is sandboxed with no scripts, and a file can be asked for as
//! an attachment (`?download=1`) so it saves instead of opening.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use uuid::Uuid;

use crate::domain::{Error, ErrorCode, Result};

/// How many files are shared at once; the oldest share goes when another comes.
const MAX_SHARES: usize = 200;
const MAX_CONNECTIONS: usize = 32;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_HEADER_BYTES: usize = 16 * 1024;
const NAME_MAX: usize = 120;

/// A file on offer, as the agent is told about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedFile {
    pub id: String,
    pub name: String,
    pub mime: &'static str,
    pub size: u64,
    /// Where it is shown: opening it in a frame or an `<object>`.
    pub url: String,
    /// The same file as an attachment, so a browser saves it.
    pub download_url: String,
}

#[derive(Clone)]
struct Share {
    id: String,
    /// Canonical path, checked again when the file is asked for.
    path: PathBuf,
    name: String,
    mime: &'static str,
}

struct Inner {
    shares: Mutex<Vec<Share>>,
    port: u16,
    stop: AtomicBool,
    active: AtomicUsize,
}

pub struct FileServer {
    inner: Arc<Inner>,
}

impl FileServer {
    /// Binds `127.0.0.1` on a port the OS picks and starts answering in the background.
    pub fn start() -> Result<Arc<Self>> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("could not bind the file server: {error}"),
            )
        })?;
        let port = listener
            .local_addr()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?
            .port();
        let inner = Arc::new(Inner {
            shares: Mutex::new(Vec::new()),
            port,
            stop: AtomicBool::new(false),
            active: AtomicUsize::new(0),
        });
        let accepting = Arc::clone(&inner);
        thread::Builder::new()
            .name("ataraxia-files".into())
            .spawn(move || accept_loop(listener, accepting))
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        Ok(Arc::new(Self { inner }))
    }

    pub fn port(&self) -> u16 {
        self.inner.port
    }

    /// Puts a file on offer. The caller has decided the file may be shown (the path is already
    /// canonical and inside what the chat may publish); sharing the same file under the same name
    /// again gives the same address.
    pub fn share(&self, path: &Path, name: Option<&str>) -> Result<SharedFile> {
        let metadata = std::fs::metadata(path).map_err(|error| {
            Error::new(
                ErrorCode::NotFound,
                format!("cannot read that file: {error}"),
            )
        })?;
        if !metadata.is_file() {
            return Err(Error::new(ErrorCode::Invalid, "only a file can be shared"));
        }
        let fallback = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = clean_name(name.unwrap_or(&fallback));
        if name.is_empty() {
            return Err(Error::new(ErrorCode::Invalid, "the file needs a name"));
        }
        let mime = mime_for(&name);
        let share = {
            let mut shares = self.inner.shares.lock();
            let known = shares
                .iter()
                .find(|share| share.path == path && share.name == name)
                .cloned();
            match known {
                Some(share) => share,
                None => {
                    let share = Share {
                        id: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
                        path: path.to_path_buf(),
                        name,
                        mime,
                    };
                    shares.push(share.clone());
                    if shares.len() > MAX_SHARES {
                        shares.remove(0);
                    }
                    share
                }
            }
        };
        let url = format!(
            "http://127.0.0.1:{}/f/{}/{}",
            self.inner.port,
            share.id,
            encode(&share.name)
        );
        Ok(SharedFile {
            download_url: format!("{url}?download=1"),
            url,
            id: share.id,
            name: share.name,
            mime: share.mime,
            size: metadata.len(),
        })
    }

    /// Stops offering a file. Returns whether the id was known.
    pub fn revoke(&self, id: &str) -> bool {
        let mut shares = self.inner.shares.lock();
        let before = shares.len();
        shares.retain(|share| share.id != id);
        shares.len() != before
    }
}

impl Drop for FileServer {
    fn drop(&mut self) {
        // Wakes the accept loop so it sees the flag and ends.
        self.inner.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.inner.port));
    }
}

/// A name that is safe to show and to put in a header: no folders, no control characters.
fn clean_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = last.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim();
    cleaned.chars().take(NAME_MAX).collect()
}

/// What a browser is told the file is, from its extension.
pub fn mime_for(name: &str) -> &'static str {
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "html" | "htm" | "xhtml" => "text/html; charset=utf-8",
        "svg" => "image/svg+xml",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "json" => "application/json",
        "csv" => "text/csv; charset=utf-8",
        "md" | "txt" | "log" | "diff" | "patch" => "text/plain; charset=utf-8",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// A page that can run code in a browser: shown, it gets a sandbox with no scripts.
fn is_active_content(mime: &str) -> bool {
    mime.starts_with("text/html") || mime.starts_with("image/svg") || mime.contains("xml")
}

const UNRESERVED: &[u8] = b"-._~";

fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || UNRESERVED.contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = text.get(at + 1..at + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

// ------------------------------------------------------------------ http

fn accept_loop(listener: TcpListener, inner: Arc<Inner>) {
    for stream in listener.incoming() {
        if inner.stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(mut stream) = stream else {
            thread::sleep(Duration::from_millis(50));
            continue;
        };
        let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
        let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
        if inner.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            inner.active.fetch_sub(1, Ordering::SeqCst);
            let _ = respond(&mut stream, 503, "Service Unavailable", &[], b"busy", true);
            continue;
        }
        let worker = Arc::clone(&inner);
        let spawned = thread::Builder::new()
            .name("ataraxia-files-conn".into())
            .spawn(move || {
                serve(&worker, stream);
                worker.active.fetch_sub(1, Ordering::SeqCst);
            });
        if spawned.is_err() {
            inner.active.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

struct Request {
    method: String,
    target: String,
    host: Option<String>,
    range: Option<String>,
}

fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream.take(MAX_HEADER_BYTES as u64));
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let (mut host, mut range) = (None, None);
    loop {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "host" => host = Some(value.trim().to_string()),
                "range" => range = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }
    Some(Request {
        method,
        target,
        host,
        range,
    })
}

fn serve(inner: &Inner, mut stream: TcpStream) {
    let Some(request) = read_request(&stream) else {
        let _ = respond(&mut stream, 400, "Bad Request", &[], b"bad request", true);
        return;
    };
    let head = request.method == "HEAD";
    if request.method != "GET" && !head {
        let _ = respond(
            &mut stream,
            405,
            "Method Not Allowed",
            &[("Allow", "GET, HEAD".into())],
            b"only GET and HEAD",
            true,
        );
        return;
    }
    let host_ok = request.host.as_deref().is_some_and(|host| {
        let host = host.to_ascii_lowercase();
        host == format!("127.0.0.1:{}", inner.port) || host == format!("localhost:{}", inner.port)
    });
    if !host_ok {
        let _ = respond(&mut stream, 403, "Forbidden", &[], b"forbidden", true);
        return;
    }
    let (path, query) = request
        .target
        .split_once('?')
        .unwrap_or((request.target.as_str(), ""));
    let Some(share) = find(inner, path) else {
        let _ = respond(&mut stream, 404, "Not Found", &[], b"not found", true);
        return;
    };
    send_file(&mut stream, &share, query, request.range.as_deref(), head);
}

/// The share an address names: `/f/<id>/<name>`, the name as it was given out.
fn find(inner: &Inner, path: &str) -> Option<Share> {
    let rest = path.strip_prefix("/f/")?;
    let (id, name) = rest.split_once('/')?;
    let name = decode(name)?;
    inner
        .shares
        .lock()
        .iter()
        .find(|share| share.id == id && share.name == name)
        .cloned()
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n` against a file of `size` bytes: the first and last byte.
fn parse_range(value: &str, size: u64) -> Option<std::result::Result<(u64, u64), ()>> {
    let spec = value.strip_prefix("bytes=")?;
    if spec.contains(',') {
        // Several ranges are not worth the trouble: the whole file answers them.
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let range = match (start.trim(), end.trim()) {
        ("", "") => return None,
        ("", suffix) => {
            let length: u64 = suffix.parse().ok()?;
            (size.saturating_sub(length), size.saturating_sub(1))
        }
        (start, "") => (start.parse().ok()?, size.saturating_sub(1)),
        (start, end) => (
            start.parse().ok()?,
            end.parse::<u64>().ok()?.min(size.saturating_sub(1)),
        ),
    };
    if size == 0 || range.0 > range.1 || range.0 >= size {
        return Some(Err(()));
    }
    Some(Ok(range))
}

fn send_file(stream: &mut TcpStream, share: &Share, query: &str, range: Option<&str>, head: bool) {
    // The file is the one that was shared: a path that now leads somewhere else (a link swapped in
    // since) is not served.
    let opened = std::fs::canonicalize(&share.path)
        .ok()
        .filter(|now| *now == share.path)
        .and_then(|_| File::open(&share.path).ok());
    let Some(mut file) = opened else {
        let _ = respond(stream, 404, "Not Found", &[], b"not found", true);
        return;
    };
    let Ok(size) = file.metadata().map(|metadata| metadata.len()) else {
        let _ = respond(stream, 404, "Not Found", &[], b"not found", true);
        return;
    };
    let mut headers: Vec<(&str, String)> = vec![
        ("Content-Type", share.mime.to_string()),
        ("X-Content-Type-Options", "nosniff".into()),
        ("Cache-Control", "no-store".into()),
        ("Accept-Ranges", "bytes".into()),
    ];
    if is_active_content(share.mime) {
        headers.push((
            "Content-Security-Policy",
            "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:"
                .into(),
        ));
    }
    let attachment = query.split('&').any(|pair| pair == "download=1");
    let disposition = if attachment { "attachment" } else { "inline" };
    let ascii: String = share
        .name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    headers.push((
        "Content-Disposition",
        format!(
            "{disposition}; filename=\"{ascii}\"; filename*=UTF-8''{}",
            encode(&share.name)
        ),
    ));

    let (status, reason, start, length) = match range.and_then(|value| parse_range(value, size)) {
        None => (200, "OK", 0, size),
        Some(Ok((first, last))) => {
            headers.push(("Content-Range", format!("bytes {first}-{last}/{size}")));
            (206, "Partial Content", first, last - first + 1)
        }
        Some(Err(())) => {
            let _ = respond(
                stream,
                416,
                "Range Not Satisfiable",
                &[("Content-Range", format!("bytes */{size}"))],
                b"",
                true,
            );
            return;
        }
    };
    headers.push(("Content-Length", length.to_string()));
    if write_head(stream, status, reason, &headers).is_err() || head {
        return;
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    // A reader that goes away halfway is not an error worth more than stopping.
    let mut body = file.take(length);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match body.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if stream.write_all(&chunk[..n]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

fn write_head(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    headers: &[(&str, String)],
) -> std::io::Result<()> {
    let mut text = format!("HTTP/1.1 {status} {reason}\r\nConnection: close\r\n");
    for (name, value) in headers {
        text.push_str(&format!("{name}: {value}\r\n"));
    }
    text.push_str("\r\n");
    stream.write_all(text.as_bytes())
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    extra: &[(&str, String)],
    body: &[u8],
    close: bool,
) -> std::io::Result<()> {
    let mut headers: Vec<(&str, String)> = vec![
        ("Content-Type", "text/plain; charset=utf-8".into()),
        ("X-Content-Type-Options", "nosniff".into()),
        ("Content-Length", body.len().to_string()),
    ];
    headers.extend(extra.iter().cloned());
    write_head(stream, status, reason, &headers)?;
    stream.write_all(body)?;
    stream.flush()?;
    if close {
        let _ = stream.shutdown(Shutdown::Both);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Reply {
        status: u16,
        headers: String,
        body: Vec<u8>,
    }

    impl Reply {
        fn header(&self, name: &str) -> Option<String> {
            self.headers.lines().find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case(name)
                    .then(|| value.trim().to_string())
            })
        }
    }

    fn fetch(server: &FileServer, method: &str, target: &str, extra: &[&str]) -> Reply {
        let host = format!("127.0.0.1:{}", server.port());
        fetch_as(server, method, target, &host, extra)
    }

    fn fetch_as(
        server: &FileServer,
        method: &str,
        target: &str,
        host: &str,
        extra: &[&str],
    ) -> Reply {
        let mut stream = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
        let mut request = format!("{method} {target} HTTP/1.1\r\nHost: {host}\r\n");
        for line in extra {
            request.push_str(line);
            request.push_str("\r\n");
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).unwrap();
        let mut raw = Vec::new();
        let _ = stream.read_to_end(&mut raw);
        let split = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("a complete answer");
        let head = String::from_utf8_lossy(&raw[..split]).into_owned();
        let mut lines = head.lines();
        let status = lines
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())
            .unwrap();
        Reply {
            status,
            headers: lines.collect::<Vec<_>>().join("\n"),
            body: raw[split + 4..].to_vec(),
        }
    }

    fn folder() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ataraxia-files-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn path_of(url: &str) -> String {
        url.split_once("127.0.0.1:")
            .and_then(|(_, rest)| rest.split_once('/'))
            .map(|(_, path)| format!("/{path}"))
            .unwrap()
    }

    #[test]
    fn a_shared_file_is_served_with_its_type_and_cannot_be_sniffed() {
        let dir = folder();
        let file = dir.join("report.pdf");
        std::fs::write(&file, b"%PDF-1.4 pretend").unwrap();
        let server = FileServer::start().unwrap();
        let shared = server.share(&file, None).unwrap();
        assert_eq!(shared.name, "report.pdf");
        assert_eq!(shared.mime, "application/pdf");
        assert_eq!(shared.size, 16);
        assert!(shared.url.starts_with("http://127.0.0.1:"));
        assert!(shared.download_url.ends_with("?download=1"));

        let reply = fetch(&server, "GET", &path_of(&shared.url), &[]);
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body, b"%PDF-1.4 pretend");
        assert_eq!(
            reply.header("content-type").as_deref(),
            Some("application/pdf")
        );
        assert_eq!(
            reply.header("x-content-type-options").as_deref(),
            Some("nosniff")
        );
        assert!(
            reply
                .header("content-disposition")
                .unwrap()
                .starts_with("inline;")
        );
        // A PDF is not a page that runs code, so it is not sandboxed (a viewer would not open).
        assert_eq!(reply.header("content-security-policy"), None);

        let saved = fetch(&server, "GET", &path_of(&shared.download_url), &[]);
        assert!(
            saved
                .header("content-disposition")
                .unwrap()
                .starts_with("attachment;")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_page_that_can_run_code_is_sandboxed_without_scripts() {
        let dir = folder();
        let file = dir.join("page.html");
        std::fs::write(&file, b"<script>alert(1)</script>").unwrap();
        let server = FileServer::start().unwrap();
        let shared = server.share(&file, None).unwrap();
        let reply = fetch(&server, "GET", &path_of(&shared.url), &[]);
        let policy = reply.header("content-security-policy").expect("a policy");
        assert!(policy.starts_with("sandbox"), "{policy}");
        assert!(!policy.contains("allow-scripts"));
        assert!(policy.contains("default-src 'none'"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_the_address_that_was_given_out_is_served() {
        let dir = folder();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hello").unwrap();
        let server = FileServer::start().unwrap();
        let shared = server.share(&file, None).unwrap();
        let path = path_of(&shared.url);

        // Not the id, not the name, not a way up, nothing at the root, no listing.
        let wrong_id = path.replacen(&shared.id[..4], "0000", 1);
        assert_eq!(fetch(&server, "GET", &wrong_id, &[]).status, 404);
        assert_eq!(
            fetch(&server, "GET", &format!("/f/{}/other.txt", shared.id), &[]).status,
            404
        );
        assert_eq!(
            fetch(
                &server,
                "GET",
                &format!("/f/{}/../../etc/passwd", shared.id),
                &[]
            )
            .status,
            404
        );
        assert_eq!(fetch(&server, "GET", "/", &[]).status, 404);
        assert_eq!(fetch(&server, "GET", "/f/", &[]).status, 404);
        assert_eq!(
            fetch(&server, "GET", &format!("/f/{}/", shared.id), &[]).status,
            404
        );

        // Only reading: no POST, no PUT.
        assert_eq!(fetch(&server, "POST", &path, &[]).status, 405);
        assert_eq!(fetch(&server, "PUT", &path, &[]).status, 405);
        assert_eq!(fetch(&server, "GET", &path, &[]).status, 200);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_request_for_another_host_name_is_refused() {
        let dir = folder();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hello").unwrap();
        let server = FileServer::start().unwrap();
        let shared = server.share(&file, None).unwrap();
        let path = path_of(&shared.url);
        for host in [
            "evil.example",
            "evil.example:80",
            "127.0.0.1",
            "127.0.0.1:1",
        ] {
            assert_eq!(
                fetch_as(&server, "GET", &path, host, &[]).status,
                403,
                "{host}"
            );
        }
        let local = format!("localhost:{}", server.port());
        assert_eq!(fetch_as(&server, "GET", &path, &local, &[]).status, 200);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_range_is_answered_with_that_part_and_a_bad_one_is_refused() {
        let dir = folder();
        let file = dir.join("clip.mp4");
        std::fs::write(&file, b"0123456789").unwrap();
        let server = FileServer::start().unwrap();
        let shared = server.share(&file, None).unwrap();
        let path = path_of(&shared.url);

        let part = fetch(&server, "GET", &path, &["Range: bytes=2-5"]);
        assert_eq!(part.status, 206);
        assert_eq!(part.body, b"2345");
        assert_eq!(
            part.header("content-range").as_deref(),
            Some("bytes 2-5/10")
        );
        let tail = fetch(&server, "GET", &path, &["Range: bytes=-3"]);
        assert_eq!(tail.body, b"789");
        let open = fetch(&server, "GET", &path, &["Range: bytes=7-"]);
        assert_eq!(open.body, b"789");
        let clipped = fetch(&server, "GET", &path, &["Range: bytes=8-99"]);
        assert_eq!(clipped.body, b"89");
        assert_eq!(
            fetch(&server, "GET", &path, &["Range: bytes=50-60"]).status,
            416
        );
        assert_eq!(
            fetch(&server, "GET", &path, &["Range: bytes=5-2"]).status,
            416
        );
        // What is not understood answers with the whole file.
        assert_eq!(
            fetch(&server, "GET", &path, &["Range: bytes=0-1,4-5"]).body,
            b"0123456789"
        );
        assert_eq!(
            fetch(&server, "GET", &path, &["Range: nonsense"]).body,
            b"0123456789"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn head_says_what_get_would_without_the_body() {
        let dir = folder();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hello").unwrap();
        let server = FileServer::start().unwrap();
        let shared = server.share(&file, None).unwrap();
        let reply = fetch(&server, "HEAD", &path_of(&shared.url), &[]);
        assert_eq!(reply.status, 200);
        assert_eq!(reply.header("content-length").as_deref(), Some("5"));
        assert!(reply.body.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_that_changed_shows_what_it_holds_now_and_one_that_is_gone_is_not_found() {
        let dir = folder();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"one").unwrap();
        let server = FileServer::start().unwrap();
        let shared = server.share(&file, None).unwrap();
        let path = path_of(&shared.url);
        std::fs::write(&file, b"two!").unwrap();
        assert_eq!(fetch(&server, "GET", &path, &[]).body, b"two!");
        std::fs::remove_file(&file).unwrap();
        assert_eq!(fetch(&server, "GET", &path, &[]).status, 404);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_path_that_now_leads_somewhere_else_is_not_served() {
        let dir = folder();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"mine").unwrap();
        let secret = dir.join("secret.txt");
        std::fs::write(&secret, b"not for the chat").unwrap();
        let server = FileServer::start().unwrap();
        let shared = server.share(&file, None).unwrap();
        std::fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(&secret, &file).unwrap();
        assert_eq!(
            fetch(&server, "GET", &path_of(&shared.url), &[]).status,
            404
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sharing_again_gives_the_same_address_and_revoking_stops_it() {
        let dir = folder();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hello").unwrap();
        let server = FileServer::start().unwrap();
        let first = server.share(&file, None).unwrap();
        let again = server.share(&file, None).unwrap();
        assert_eq!(first.url, again.url);
        let renamed = server.share(&file, Some("notes.txt")).unwrap();
        assert_ne!(first.url, renamed.url);
        assert!(server.revoke(&first.id));
        assert!(!server.revoke(&first.id));
        assert_eq!(fetch(&server, "GET", &path_of(&first.url), &[]).status, 404);
        assert_eq!(
            fetch(&server, "GET", &path_of(&renamed.url), &[]).status,
            200
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_oldest_share_goes_when_there_are_too_many() {
        let dir = folder();
        let server = FileServer::start().unwrap();
        let mut urls = Vec::new();
        for index in 0..=MAX_SHARES {
            let file = dir.join(format!("f{index}.txt"));
            std::fs::write(&file, b"x").unwrap();
            urls.push(server.share(&file, None).unwrap().url);
        }
        assert_eq!(fetch(&server, "GET", &path_of(&urls[0]), &[]).status, 404);
        assert_eq!(
            fetch(&server, "GET", &path_of(&urls[MAX_SHARES]), &[]).status,
            200
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn names_are_cleaned_and_addresses_are_encoded() {
        let dir = folder();
        let file = dir.join("my report (final).txt");
        std::fs::write(&file, b"x").unwrap();
        let server = FileServer::start().unwrap();
        let shared = server.share(&file, Some("../../évil\r\nname.txt")).unwrap();
        assert!(!shared.name.contains('/') && !shared.name.contains('\r'));
        let reply = fetch(&server, "GET", &path_of(&shared.url), &[]);
        assert_eq!(reply.status, 200);
        let disposition = reply.header("content-disposition").unwrap();
        assert!(!disposition.contains('\n'));
        assert!(
            disposition.contains("filename*=UTF-8''%C3%A9vilname.txt"),
            "{disposition}"
        );

        let plain = server.share(&file, None).unwrap();
        assert_eq!(plain.name, "my report (final).txt");
        assert_eq!(fetch(&server, "GET", &path_of(&plain.url), &[]).status, 200);
        assert!(server.share(&file, Some("///")).is_err());
        assert!(server.share(&dir, None).is_err(), "a folder is not a file");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mime_types_come_from_the_extension() {
        assert_eq!(mime_for("a.PDF"), "application/pdf");
        assert_eq!(mime_for("a.html"), "text/html; charset=utf-8");
        assert_eq!(mime_for("a.unknown"), "application/octet-stream");
        assert_eq!(mime_for("noextension"), "application/octet-stream");
        assert!(is_active_content(mime_for("a.svg")));
        assert!(!is_active_content(mime_for("a.png")));
    }
}
