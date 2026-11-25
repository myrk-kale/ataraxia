use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use ureq::{Agent, Body, http::Response};
use url::Url;
use uuid::Uuid;

use super::config::prepare_private_dir;
use crate::domain::{Error, ErrorCode, Result};

const CALLBACK_PATH: &str = "/mcp/oauth/callback";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);
static CREDENTIALS: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Status {
    SignIn,
    Authorized,
}

#[derive(Deserialize)]
struct ResourceMetadata {
    resource: Url,
    authorization_servers: Vec<Url>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

#[derive(Deserialize)]
struct ServerMetadata {
    issuer: Url,
    authorization_endpoint: Url,
    token_endpoint: Url,
    registration_endpoint: Option<Url>,
    #[serde(default)]
    code_challenge_methods_supported: Vec<String>,
}

#[derive(Deserialize, Serialize)]
struct ClientRegistration {
    client_id: String,
    client_secret: Option<String>,
    token_endpoint_auth_method: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Credentials {
    client: ClientRegistration,
    token_endpoint: Url,
    access_token: String,
    expires_at: Option<u64>,
    refresh_token: Option<String>,
}

impl Credentials {
    fn fresh(&self) -> bool {
        self.expires_at
            .is_none_or(|expiry| expiry > now().saturating_add(30))
    }

    fn update(&mut self, response: TokenResponse) -> Result<()> {
        if !response.token_type.eq_ignore_ascii_case("bearer")
            || response.access_token.is_empty()
            || !response
                .access_token
                .bytes()
                .all(|byte| byte.is_ascii_graphic())
        {
            return Err(oauth_error("MCP OAuth did not return a valid bearer token"));
        }
        self.access_token = response.access_token;
        self.expires_at = response
            .expires_in
            .map(|seconds| now().saturating_add(seconds));
        if response.refresh_token.is_some() {
            self.refresh_token = response.refresh_token;
        }
        Ok(())
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn oauth_error(message: &str) -> Error {
    Error::new(ErrorCode::Agent, message)
}

fn https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.has_host()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn endpoint(value: &str) -> Option<Url> {
    Url::parse(value).ok().filter(https)
}

fn has_authorization(config: &Value) -> bool {
    ["headers", "http_headers", "env_http_headers"]
        .iter()
        .any(|field| {
            config
                .get(field)
                .and_then(Value::as_object)
                .is_some_and(|headers| {
                    headers
                        .keys()
                        .any(|name| name.eq_ignore_ascii_case("authorization"))
                })
        })
        || config.get("bearer_token_env_var").is_some()
}

fn oauth_resource(config: &Value) -> Option<Url> {
    if has_authorization(config) {
        return None;
    }
    endpoint(config.get("url")?.as_str()?)
}

fn credential_path(root: &Path, resource: &Url) -> PathBuf {
    let key = format!("{:x}", Sha256::digest(resource.as_str().as_bytes()));
    root.join("mcp-oauth").join(format!("{key}.json"))
}

fn load(path: &Path) -> Option<Credentials> {
    let file = fs::File::open(path).ok()?;
    serde_json::from_reader(file).ok()
}

fn save(path: &Path, credentials: &Credentials) -> Result<()> {
    let dir = path.parent().expect("MCP credentials directory");
    prepare_private_dir(dir)?;
    let write = || -> std::io::Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(dir)?;
        serde_json::to_writer(&mut file, credentials)?;
        file.persist(path)?;
        Ok(())
    };
    write().map_err(|_| Error::new(ErrorCode::Io, "Could not save MCP authorization"))
}

pub(super) fn status(root: &Path, config: &Value) -> Option<Status> {
    let resource = oauth_resource(config)?;
    let authorized = load(&credential_path(root, &resource))
        .is_some_and(|saved| saved.fresh() || saved.refresh_token.is_some());
    Some(if authorized {
        Status::Authorized
    } else {
        Status::SignIn
    })
}

fn http_agent() -> Agent {
    Agent::config_builder()
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(12)))
        .build()
        .into()
}

fn json_response<T: serde::de::DeserializeOwned>(
    result: std::result::Result<Response<Body>, ureq::Error>,
    message: &str,
) -> Result<T> {
    let mut response = result.map_err(|_| oauth_error(message))?;
    if !response.status().is_success() {
        return Err(Error::new(
            ErrorCode::Agent,
            format!("{message} (HTTP {})", response.status().as_u16()),
        ));
    }
    let bytes = response
        .body_mut()
        .with_config()
        .limit(256 * 1024)
        .read_to_vec()
        .map_err(|_| oauth_error(message))?;
    serde_json::from_slice(&bytes).map_err(|_| oauth_error(message))
}

fn well_known(base: &Url, name: &str) -> Url {
    let mut result = base.clone();
    let path = base.path().trim_end_matches('/');
    result.set_path(&format!("/.well-known/{name}{path}"));
    result.set_query(None);
    result
}

fn challenge_parameter<'a>(challenge: &'a str, key: &str) -> Option<&'a str> {
    challenge
        .split_once(&format!("{key}=\""))?
        .1
        .split_once('"')
        .map(|(value, _)| value)
}

fn discover(agent: &Agent, resource: &Url) -> Result<(Option<String>, ServerMetadata)> {
    let challenge = agent
        .get(resource.as_str())
        .call()
        .ok()
        .and_then(|response| {
            Some(
                response
                    .headers()
                    .get("www-authenticate")?
                    .to_str()
                    .ok()?
                    .to_owned(),
            )
        });
    let metadata_url = challenge
        .as_deref()
        .and_then(|header| challenge_parameter(header, "resource_metadata"))
        .and_then(endpoint)
        .unwrap_or_else(|| well_known(resource, "oauth-protected-resource"));
    let resource_metadata: ResourceMetadata = json_response(
        agent.get(metadata_url.as_str()).call(),
        "Could not discover MCP OAuth resource metadata",
    )?;
    if &resource_metadata.resource != resource {
        return Err(oauth_error("MCP OAuth metadata names a different resource"));
    }
    let issuer = resource_metadata
        .authorization_servers
        .iter()
        .find(|url| https(url) && url.query().is_none())
        .ok_or_else(|| oauth_error("MCP OAuth metadata has no HTTPS authorization server"))?;
    let metadata = well_known(issuer, "oauth-authorization-server");
    let server: ServerMetadata = json_response(
        agent.get(metadata.as_str()).call(),
        "Could not discover the MCP authorization server",
    )?;
    if &server.issuer != issuer
        || !https(&server.authorization_endpoint)
        || !https(&server.token_endpoint)
        || !server
            .code_challenge_methods_supported
            .iter()
            .any(|method| method == "S256")
    {
        return Err(oauth_error(
            "MCP OAuth discovery requires a matching HTTPS issuer and S256 PKCE",
        ));
    }
    let requested_scope = challenge
        .as_deref()
        .and_then(|header| challenge_parameter(header, "scope"))
        .map(str::to_owned)
        .or_else(|| match resource_metadata.scopes_supported.as_slice() {
            [scope] => Some(scope.clone()),
            _ => None,
        });
    Ok((requested_scope, server))
}

fn exchange<'a>(
    agent: &Agent,
    endpoint: &Url,
    client: &'a ClientRegistration,
    mut form: Vec<(&str, &'a str)>,
) -> Result<TokenResponse> {
    if !https(endpoint) {
        return Err(oauth_error("MCP OAuth requires an HTTPS token endpoint"));
    }
    let mut request = agent.post(endpoint.as_str());
    match (
        client.token_endpoint_auth_method.as_deref(),
        client.client_secret.as_deref(),
    ) {
        (Some("client_secret_post"), Some(secret)) => {
            form.push(("client_id", &client.client_id));
            form.push(("client_secret", secret));
        }
        (Some("client_secret_basic"), Some(secret)) => {
            let encode = |value: &str| {
                url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()
            };
            let pair = format!("{}:{}", encode(&client.client_id), encode(secret));
            let encoded = base64::engine::general_purpose::STANDARD.encode(pair);
            request = request.header("Authorization", format!("Basic {encoded}"));
        }
        (None | Some("none"), _) => form.push(("client_id", &client.client_id)),
        _ => {
            return Err(oauth_error(
                "MCP OAuth client authentication method is unsupported",
            ));
        }
    }
    json_response(request.send_form(form), "MCP OAuth token exchange failed")
}

fn random_secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn callback(
    socket: &TcpListener,
    redirect: &Url,
    state: &str,
    issuer: &Url,
) -> Result<(TcpStream, String)> {
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    while Instant::now() < deadline {
        let (mut stream, _) = match socket.accept() {
            Ok(connection) => connection,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(80));
                continue;
            }
            Err(_) => return Err(oauth_error("Could not receive the MCP OAuth callback")),
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let mut first_line = String::new();
        use std::io::Read;
        if BufReader::new(&stream)
            .take(8192)
            .read_line(&mut first_line)
            .is_err()
        {
            continue;
        }
        let parsed = first_line
            .split_whitespace()
            .nth(1)
            .filter(|target| {
                target.starts_with('/')
                    && !target.starts_with("//")
                    && first_line.starts_with("GET ")
            })
            .and_then(|target| redirect.join(target).ok())
            .filter(|url| url.path() == CALLBACK_PATH && url.origin() == redirect.origin());
        if let Some(url) = parsed {
            let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
            if params.get("state").is_some_and(|value| value == state)
                && params
                    .get("iss")
                    .is_none_or(|value| Url::parse(value).as_ref().ok() == Some(issuer))
            {
                if let Some(code) = params.get("code").filter(|code| !code.is_empty()) {
                    return Ok((stream, code.clone()));
                }
                reply(&mut stream, false);
                return Err(oauth_error("MCP authorization was declined"));
            }
        }
        reply(&mut stream, false);
    }
    Err(oauth_error("MCP sign-in timed out. Try signing in again."))
}

fn reply(stream: &mut TcpStream, success: bool) {
    let (status, text) = if success {
        (
            "200 OK",
            "MCP authorization complete. You can return to Ataraxia.",
        )
    } else {
        (
            "400 Bad Request",
            "MCP authorization could not be completed. Return to Ataraxia.",
        )
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
}

const REGISTER_FAILED: &str = "Could not register Ataraxia with the MCP authorization server";

/// A server that answers the registration with 401 or 403 is not failing: it is turning
/// Ataraxia down. Some MCP servers only register the apps on their own approved list (Figma's
/// remote one answers 403 `Forbidden` to any other), and nothing in the request can change that.
fn refused_registration(status: u16) -> Error {
    oauth_error(&format!(
        "{REGISTER_FAILED} (HTTP {status}). The server refused Ataraxia: some MCP servers only register the apps on their own approved list."
    ))
}

/// Registers Ataraxia as a public client (RFC 7591) with the authorization server.
fn register_client(agent: &Agent, endpoint: &Url, redirect: &Url) -> Result<ClientRegistration> {
    let response = agent
        .post(endpoint.as_str())
        .header("Content-Type", "application/json")
        .send(
            json!({
                "client_name": "Ataraxia",
                "redirect_uris": [redirect],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none"
            })
            .to_string(),
        );
    if let Ok(refused) = &response
        && matches!(refused.status().as_u16(), 401 | 403)
    {
        return Err(refused_registration(refused.status().as_u16()));
    }
    json_response(response, REGISTER_FAILED)
}

pub(super) fn sign_in(
    root: &Path,
    config: &Value,
    open_browser: impl FnOnce(&str) -> Result<()>,
) -> Result<()> {
    let resource = oauth_resource(config).ok_or_else(|| {
        Error::new(
            ErrorCode::Invalid,
            "Choose an HTTPS MCP server without a configured Authorization header",
        )
    })?;
    let agent = http_agent();
    let (scope, server) = discover(&agent, &resource)?;
    let registration = server
        .registration_endpoint
        .as_ref()
        .filter(|url| https(url))
        .ok_or_else(|| {
            oauth_error("This MCP server does not support dynamic client registration")
        })?;
    let socket = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| oauth_error("Could not start the MCP OAuth callback listener"))?;
    socket
        .set_nonblocking(true)
        .map_err(|_| oauth_error("Could not configure the OAuth callback listener"))?;
    let address = socket
        .local_addr()
        .map_err(|_| oauth_error("Could not read the OAuth callback address"))?;
    let redirect =
        Url::parse(&format!("http://{address}{CALLBACK_PATH}")).expect("local OAuth redirect");
    let client = register_client(&agent, registration, &redirect)?;
    let verifier = random_secret();
    let state = random_secret();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut authorize = server.authorization_endpoint;
    authorize.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", &client.client_id),
        ("redirect_uri", redirect.as_str()),
        ("resource", resource.as_str()),
        ("state", &state),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
    ]);
    if let Some(scope) = scope {
        authorize.query_pairs_mut().append_pair("scope", &scope);
    }
    open_browser(authorize.as_str())?;
    let (mut stream, code) = callback(&socket, &redirect, &state, &server.issuer)?;
    let finish = || -> Result<()> {
        let response = exchange(
            &agent,
            &server.token_endpoint,
            &client,
            vec![
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", redirect.as_str()),
                ("code_verifier", &verifier),
                ("resource", resource.as_str()),
            ],
        )?;
        let mut credentials = Credentials {
            client,
            token_endpoint: server.token_endpoint,
            access_token: String::new(),
            expires_at: None,
            refresh_token: None,
        };
        credentials.update(response)?;
        let _guard = CREDENTIALS.lock();
        save(&credential_path(root, &resource), &credentials)
    };
    let result = finish();
    reply(&mut stream, result.is_ok());
    result
}

pub(super) fn apply(root: &Path, config: &mut Value) {
    let Some(resource) = oauth_resource(config) else {
        return;
    };
    let _guard = CREDENTIALS.lock();
    let path = credential_path(root, &resource);
    let Some(mut saved) = load(&path) else { return };
    if !saved.fresh() {
        let Some(refresh) = &saved.refresh_token else {
            return;
        };
        let agent = http_agent();
        let response = exchange(
            &agent,
            &saved.token_endpoint,
            &saved.client,
            vec![
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
                ("resource", resource.as_str()),
            ],
        );
        let Ok(response) = response else { return };
        if saved
            .update(response)
            .and_then(|()| save(&path, &saved))
            .is_err()
        {
            return;
        }
    }
    let headers = config
        .as_object_mut()
        .expect("MCP object")
        .entry("headers")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(headers) = headers.as_object_mut() {
        headers.insert(
            "Authorization".into(),
            Value::String(format!("Bearer {}", saved.access_token)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_authorization_applies_only_to_the_same_endpoint_without_manual_auth() {
        let root = tempfile::tempdir().unwrap();
        let resource = Url::parse("https://example.test/mcp").unwrap();
        let path = credential_path(root.path(), &resource);
        let credentials = Credentials {
            client: ClientRegistration {
                client_id: "test".into(),
                client_secret: None,
                token_endpoint_auth_method: None,
            },
            token_endpoint: resource.join("/token").unwrap(),
            access_token: "test-bearer".into(),
            expires_at: Some(now() + 3600),
            refresh_token: None,
        };
        save(&path, &credentials).unwrap();
        let mut remote = json!({"url": resource, "headers": {"X-Test": "keep"}});
        assert_eq!(status(root.path(), &remote), Some(Status::Authorized));
        apply(root.path(), &mut remote);
        assert_eq!(remote["headers"]["Authorization"], "Bearer test-bearer");
        assert_eq!(remote["headers"]["X-Test"], "keep");
        for mut config in [
            json!({"url": "https://example.test/other"}),
            json!({"url": resource, "headers": {"authorization": "manual"}}),
        ] {
            let original = config.clone();
            apply(root.path(), &mut config);
            assert_eq!(config, original);
        }
    }

    #[test]
    fn the_callback_checks_state_and_issuer_before_accepting_the_code() {
        let socket = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        socket.set_nonblocking(true).unwrap();
        let address = socket.local_addr().unwrap();
        let redirect = Url::parse(&format!("http://{address}{CALLBACK_PATH}")).unwrap();
        let issuer = Url::parse("https://example.test").unwrap();
        let browser = std::thread::spawn(move || {
            use std::io::Read;
            for state in ["wrong", "expected"] {
                let mut stream = TcpStream::connect(address).unwrap();
                write!(
                    stream,
                    "GET {CALLBACK_PATH}?state={state}&code={state} HTTP/1.1\r\nHost: {address}\r\n\r\n"
                ).unwrap();
                let mut response = String::new();
                stream.read_to_string(&mut response).unwrap();
                assert!(response.starts_with(if state == "expected" {
                    "HTTP/1.1 200"
                } else {
                    "HTTP/1.1 400"
                }));
            }
        });
        let (mut stream, code) = callback(&socket, &redirect, "expected", &issuer).unwrap();
        assert_eq!(code, "expected");
        reply(&mut stream, true);
        drop(stream);
        browser.join().unwrap();
    }

    /// A server that reads one request, answers `response` and hands back the body it received.
    fn answer_once(response: String) -> (Url, std::thread::JoinHandle<String>) {
        use std::io::Read;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let endpoint = Url::parse(&format!(
            "http://{}/register",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let served = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8(body).unwrap()
        });
        (endpoint, served)
    }

    fn reply_with(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn redirect() -> Url {
        Url::parse(&format!("http://127.0.0.1:4321{CALLBACK_PATH}")).unwrap()
    }

    #[test]
    fn a_server_that_turns_the_client_down_says_so_and_not_only_the_status() {
        // Figma's remote MCP answers every client that is not on its list with 403 "Forbidden".
        for (status, code) in [("403 Forbidden", 403), ("401 Unauthorized", 401)] {
            let (endpoint, served) = answer_once(reply_with(status, "Forbidden"));
            let Err(error) = register_client(&http_agent(), &endpoint, &redirect()) else {
                panic!("a refused registration succeeded");
            };
            served.join().unwrap();
            assert!(
                error
                    .message
                    .starts_with(&format!("{REGISTER_FAILED} (HTTP {code})")),
                "{}",
                error.message
            );
            assert!(error.message.contains("approved list"), "{}", error.message);
        }
    }

    #[test]
    fn a_registration_that_fails_for_another_reason_is_not_blamed_on_a_list() {
        let (endpoint, served) = answer_once(reply_with("500 Internal Server Error", ""));
        let Err(error) = register_client(&http_agent(), &endpoint, &redirect()) else {
            panic!("a failed registration succeeded");
        };
        served.join().unwrap();
        assert_eq!(error.message, format!("{REGISTER_FAILED} (HTTP 500)"));
    }

    #[test]
    fn registration_asks_for_a_public_client_and_reads_its_id() {
        let (endpoint, served) =
            answer_once(reply_with("201 Created", r#"{"client_id":"abc123"}"#));
        let client = register_client(&http_agent(), &endpoint, &redirect()).unwrap();
        assert_eq!(client.client_id, "abc123");
        let sent: Value = serde_json::from_str(&served.join().unwrap()).unwrap();
        assert_eq!(sent["client_name"], "Ataraxia");
        assert_eq!(sent["redirect_uris"], json!([redirect().as_str()]));
        assert_eq!(sent["token_endpoint_auth_method"], "none");
    }

    #[test]
    #[ignore = "registers a public OAuth client with the real Notion MCP"]
    fn notion_oauth_reaches_browser_authorization_after_registration() {
        let root = tempfile::tempdir().unwrap();
        let config = json!({"url": "https://mcp.notion.com/mcp"});
        let result = sign_in(root.path(), &config, |url| {
            let authorize = Url::parse(url).unwrap();
            assert_eq!(
                authorize.origin().ascii_serialization(),
                "https://mcp.notion.com"
            );
            assert_eq!(authorize.path(), "/authorize");
            let params: std::collections::HashMap<_, _> = authorize.query_pairs().collect();
            assert_eq!(params["code_challenge_method"], "S256");
            assert_eq!(params["resource"], "https://mcp.notion.com/mcp");
            assert_eq!(params["scope"], "default");
            assert!(!params["client_id"].is_empty());
            Err(oauth_error("browser verified"))
        });
        assert_eq!(result.unwrap_err().message, "browser verified");
    }
}
