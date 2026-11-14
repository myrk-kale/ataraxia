//! Provider-facing seam used by [`super::host::AgentHost`].
//!
//! A backend owns the process/protocol for one provider session and reports
//! what happened as [`BackendEvent`]s. The host turns those into transcript
//! state, session status and outbound [`crate::domain::AgentEvent`]s.

use std::path::PathBuf;
use std::sync::Arc;

use crate::domain::agent::SessionOptions;
use crate::domain::ids::{SessionId, TurnId};
use crate::domain::{
    PermissionDecision, PermissionRequestId, Result, SubagentUpdate, ToolCallId, UsageWindow,
};
use crate::ports::ApiAccess;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendEvent {
    Delta {
        turn_id: TurnId,
        text: String,
    },
    Tool {
        turn_id: TurnId,
        call_id: ToolCallId,
        name: String,
        input: String,
    },
    /// Refines a tool call announced earlier (providers often stream the input afterwards).
    ToolUpdate {
        turn_id: TurnId,
        call_id: ToolCallId,
        name: Option<String>,
        input: Option<String>,
    },
    ToolResult {
        turn_id: TurnId,
        call_id: ToolCallId,
        output: String,
        ok: bool,
    },
    Permission {
        turn_id: TurnId,
        request_id: PermissionRequestId,
        tool_name: String,
        detail: String,
    },
    TurnDone {
        turn_id: TurnId,
        ok: bool,
    },
    /// The agent started a turn nobody asked for (for example the report of a background
    /// subagent). Its events and its `TurnDone` use this id.
    TurnStarted {
        turn_id: TurnId,
    },
    /// Where the account's limits stand. The host knows which provider is speaking.
    Usage {
        plan: Option<String>,
        windows: Vec<UsageWindow>,
    },
    /// Progress inside a subagent's own conversation.
    Subagent {
        id: String,
        title: String,
        update: SubagentUpdate,
    },
    Error {
        message: String,
    },
}

/// How a message to a subagent is carried out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentRoute {
    /// Sent straight to the subagent; the main conversation stays idle.
    Direct,
    /// Relayed by the main agent, so the main conversation runs a turn meanwhile.
    MainTurn,
}

pub type Emitter = Arc<dyn Fn(BackendEvent) + Send + Sync>;

pub struct BackendContext {
    pub session_id: SessionId,
    pub cwd: PathBuf,
    /// Other repositories of the chat's workspace the agent may read and edit, besides `cwd`.
    pub extra_dirs: Vec<PathBuf>,
    /// Model override chosen for this chat (`None` = provider default).
    pub model: Option<String>,
    /// Reasoning-effort override (`None` = provider default).
    pub effort: Option<String>,
    /// Named agent to run as (`None` = the provider's default agent).
    pub agent: Option<String>,
    /// The session only investigates: provider-side sandboxing keeps it from writing.
    pub read_only: bool,
    /// Where the agent finds Ataraxia's local API, with a token for this process only.
    pub api: Option<ApiAccess>,
    /// How the chosen launch profile starts the harness; `None` is the default way.
    pub launch: Option<Launch>,
    pub emit: Emitter,
}

/// What a launch profile changes about starting a harness.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Launch {
    /// The program to run instead of the harness's usual one.
    pub program: Option<PathBuf>,
    /// Arguments that come before the ones the harness is always started with.
    pub args: Vec<String>,
    /// Variables set for the process, after (so over) the ones Ataraxia sets.
    pub env: Vec<(String, String)>,
}

/// The program to run: the profile's if it names one, else the harness's usual one.
pub fn profile_program(
    launch: Option<&Launch>,
    usual: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    launch
        .and_then(|launch| launch.program.clone())
        .or_else(usual)
}

/// The arguments to run with: the profile's, then the ones the harness is always started with.
pub fn profile_args(launch: Option<&Launch>, own: Vec<String>) -> Vec<String> {
    match launch {
        Some(launch) => launch.args.iter().cloned().chain(own).collect(),
        None => own,
    }
}

/// The environment of the process: Ataraxia's variables, then the profile's.
pub fn compose_env(
    mut base: Vec<(String, String)>,
    launch: Option<&Launch>,
) -> Vec<(String, String)> {
    if let Some(launch) = launch {
        base.extend(launch.env.iter().cloned());
    }
    base
}

pub const API_URL_ENV: &str = "ATARAXIA_API_URL";
pub const API_TOKEN_ENV: &str = "ATARAXIA_API_TOKEN";
pub const API_SESSION_ENV: &str = "ATARAXIA_SESSION_ID";

/// The variables that point an agent process at the local API; empty without API access.
pub fn api_env(session_id: SessionId, api: Option<&ApiAccess>) -> Vec<(String, String)> {
    match api {
        Some(access) => vec![
            (API_URL_ENV.into(), access.url.clone()),
            (API_TOKEN_ENV.into(), access.token.clone()),
            (API_SESSION_ENV.into(), session_id.0.to_string()),
        ],
        None => Vec::new(),
    }
}

pub trait AgentBackend: Send + Sync {
    /// `Err(reason)` when the provider cannot run on this machine (CLI missing, ...).
    fn availability(&self) -> std::result::Result<(), String> {
        Ok(())
    }

    fn start(&self, ctx: BackendContext) -> Result<Arc<dyn BackendSession>>;
}

/// A picture of a message, as a file an agent can open.
#[derive(Debug, Clone)]
pub struct ImageFile {
    pub path: std::path::PathBuf,
    pub mime: String,
    pub name: String,
}

/// The message with the pictures' places said in words, for providers that read files.
pub fn with_image_paths(text: &str, images: &[ImageFile]) -> String {
    if images.is_empty() {
        return text.to_string();
    }
    let mut out = text.to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str("The user attached these images, saved as files you can open:\n");
    for image in images {
        out.push_str(&format!("- {} ({})\n", image.path.display(), image.name));
    }
    out
}

/// A live provider session. Methods take `&self`; implementations use interior mutability.
pub trait BackendSession: Send + Sync {
    fn prompt(&self, turn_id: TurnId, text: &str) -> Result<()>;
    /// A message with pictures. A provider with no way to take them natively is told where the
    /// files are, in the text, and reads them with its own tools.
    fn prompt_with_images(&self, turn_id: TurnId, text: &str, images: &[ImageFile]) -> Result<()> {
        self.prompt(turn_id, &with_image_paths(text, images))
    }
    /// Must lead to exactly one `TurnDone { ok: false }` for the active turn.
    fn cancel(&self) -> Result<()>;
    fn resolve_permission(&self, decision: &PermissionDecision) -> Result<()>;
    /// False once the underlying process is gone; the host then restarts the session on demand.
    fn is_alive(&self) -> bool {
        true
    }
    /// Applies a new model/effort to the running session. Returns `false` when the provider can
    /// only pick them up on a fresh process, in which case the host restarts the session.
    fn apply_settings(
        &self,
        _model: Option<&str>,
        _effort: Option<&str>,
        _agent: Option<&str>,
    ) -> bool {
        false
    }
    /// Sends a message to a subagent. Its answer arrives as `Subagent` events; for
    /// `SubagentRoute::MainTurn` the main agent also runs `turn_id` and ends it with `TurnDone`.
    fn message_subagent(
        &self,
        _turn_id: TurnId,
        _subagent_id: &str,
        _text: &str,
    ) -> Result<SubagentRoute> {
        Err(crate::domain::Error::new(
            crate::domain::ErrorCode::Unsupported,
            "this provider cannot message a subagent",
        ))
    }
    /// Models, effort levels and agents this session offers; empty when unknown.
    fn options(&self) -> SessionOptions {
        SessionOptions::default()
    }
    fn shutdown(&self);
}

const MAX_OUTPUT_CHARS: usize = 20_000;

/// Caps tool output so one huge result cannot bloat the transcript or the event channel.
pub fn truncate_output(mut text: String) -> String {
    if text.chars().count() > MAX_OUTPUT_CHARS {
        text = text.chars().take(MAX_OUTPUT_CHARS).collect();
        text.push_str("\n… (truncated)");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_api_variables_name_the_address_the_token_and_the_session() {
        let session = SessionId::new();
        let access = ApiAccess {
            url: "http://127.0.0.1:4000".into(),
            token: "tok".into(),
        };
        let env = api_env(session, Some(&access));
        assert_eq!(
            env,
            vec![
                (
                    "ATARAXIA_API_URL".to_string(),
                    "http://127.0.0.1:4000".to_string()
                ),
                ("ATARAXIA_API_TOKEN".to_string(), "tok".to_string()),
                ("ATARAXIA_SESSION_ID".to_string(), session.0.to_string()),
            ]
        );
        assert!(api_env(session, None).is_empty());
        assert!(!format!("{access:?}").contains("\"tok\""));
    }

    #[cfg(unix)]
    #[test]
    fn a_spawned_process_sees_the_api_variables() {
        use std::sync::mpsc;
        use std::time::Duration;

        use super::super::process::{ManagedProcess, SpawnSpec};

        let session = SessionId::new();
        let access = ApiAccess {
            url: "http://127.0.0.1:4000".into(),
            token: "secret-token".into(),
        };
        let (lines, received) = mpsc::channel();
        let _process = ManagedProcess::spawn(
            &SpawnSpec {
                program: "sh".into(),
                args: vec![
                    "-c".into(),
                    "echo \"$ATARAXIA_API_URL $ATARAXIA_API_TOKEN $ATARAXIA_SESSION_ID\"".into(),
                ],
                cwd: std::env::temp_dir(),
                env: api_env(session, Some(&access)),
                env_remove: Vec::new(),
            },
            move |line| {
                let _ = lines.send(line);
            },
            |_| {},
        )
        .expect("spawn sh");
        let line = received
            .recv_timeout(Duration::from_secs(10))
            .expect("the process printed its environment");
        assert_eq!(
            line,
            format!("http://127.0.0.1:4000 secret-token {}", session.0)
        );
    }

    #[test]
    fn a_profile_changes_the_program_and_puts_its_arguments_first() {
        let launch = Launch {
            program: Some(PathBuf::from("/opt/work/claude")),
            args: vec!["--settings".into(), "w.json".into()],
            env: vec![("CLAUDE_CONFIG_DIR".into(), "/w".into())],
        };
        assert_eq!(
            profile_program(Some(&launch), || Some(PathBuf::from("/usr/bin/claude"))),
            Some(PathBuf::from("/opt/work/claude"))
        );
        assert_eq!(
            profile_args(Some(&launch), vec!["--verbose".into()]),
            vec!["--settings", "w.json", "--verbose"]
        );
    }

    #[test]
    fn a_profile_of_settings_alone_keeps_the_usual_program_and_arguments() {
        let launch = Launch {
            env: vec![("CODEX_HOME".into(), "/w".into())],
            ..Launch::default()
        };
        assert_eq!(
            profile_program(Some(&launch), || Some(PathBuf::from("/usr/bin/codex"))),
            Some(PathBuf::from("/usr/bin/codex"))
        );
        assert_eq!(
            profile_args(Some(&launch), vec!["app-server".into()]),
            vec!["app-server"]
        );
    }

    #[test]
    fn without_a_profile_nothing_changes() {
        assert_eq!(profile_program(None, || None), None);
        assert_eq!(profile_args(None, vec!["acp".into()]), vec!["acp"]);
        assert_eq!(
            compose_env(vec![("A".into(), "1".into())], None),
            vec![("A".to_string(), "1".to_string())]
        );
    }

    #[test]
    fn the_profiles_settings_come_after_ataraxias_so_they_win() {
        let launch = Launch {
            env: vec![("A".into(), "profile".into())],
            ..Launch::default()
        };
        let env = compose_env(vec![("A".into(), "ataraxia".into())], Some(&launch));
        assert_eq!(env.last(), Some(&("A".to_string(), "profile".to_string())));
    }
}
