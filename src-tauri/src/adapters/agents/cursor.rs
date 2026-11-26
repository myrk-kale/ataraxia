//! Cursor through the Agent Client Protocol (`cursor-agent acp`, JSON-RPC over stdio).
//!
//! The protocol work is the engine's in [`super::opencode`]; this file starts the CLI and
//! understands the extensions Cursor adds to ACP: `cursor/ask_question` (questions with
//! answers), `cursor/create_plan` (a plan the person accepts) and a few reports it sends as
//! requests and does not read the reply of.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};

use super::backend::{
    AgentBackend, BackendContext, BackendSession, Launch, api_env, compose_env, profile_args,
    profile_program,
};
use super::opencode::{Dialect, launch_acp};
use super::process::resolve_binary;
use crate::domain::{
    Error, ErrorCode, PermissionDecision, PermissionQuestion, QuestionOption, Result,
};

const BINARY_NAME: &str = "cursor-agent";
const OVERRIDE_ENV: &str = "ATARAXIA_CURSOR_BIN";

pub const ASK_QUESTION: &str = "cursor/ask_question";
pub const CREATE_PLAN: &str = "cursor/create_plan";
/// Reports Cursor sends as requests and ignores the reply of; plan updates already carry the todos.
const REPORTS: [&str; 3] = [
    "cursor/update_todos",
    "cursor/task",
    "cursor/generate_image",
];
/// The answer of a refused question that comes back as a permission request: the one option
/// that means "skip it".
const QUESTION_FALLBACK_SKIP: &str = "__ask_question_skip__";

enum Launcher {
    Resolve,
    Fixed { program: PathBuf, args: Vec<String> },
}

pub struct CursorBackend {
    launcher: Launcher,
}

impl CursorBackend {
    pub fn new() -> Self {
        Self {
            launcher: Launcher::Resolve,
        }
    }

    /// Runs an arbitrary ACP-speaking program instead of `cursor-agent acp` (tests).
    pub fn with_command(program: PathBuf, args: Vec<String>) -> Self {
        Self {
            launcher: Launcher::Fixed { program, args },
        }
    }

    fn command(
        &self,
        launch: Option<&Launch>,
    ) -> std::result::Result<(PathBuf, Vec<String>), String> {
        match &self.launcher {
            Launcher::Fixed { program, args } => Ok((program.clone(), args.clone())),
            Launcher::Resolve => {
                profile_program(launch, || resolve_binary(BINARY_NAME, OVERRIDE_ENV))
                    .map(|program| {
                        (
                            program,
                            profile_args(
                                launch,
                                vec!["--disable-auto-update".to_string(), "acp".to_string()],
                            ),
                        )
                    })
                    .ok_or_else(|| {
                        format!(
                            "cursor-agent CLI not found. Install it (https://cursor.com/cli) or set {OVERRIDE_ENV} to its path."
                        )
                    })
            }
        }
    }
}

impl Default for CursorBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentBackend for CursorBackend {
    fn availability(&self) -> std::result::Result<(), String> {
        self.command(None).map(|_| ())
    }

    fn start(&self, ctx: BackendContext) -> Result<Arc<dyn BackendSession>> {
        let (program, args) = self
            .command(ctx.launch.as_ref())
            .map_err(|message| Error::new(ErrorCode::Unsupported, message))?;
        let env = compose_env(
            api_env(ctx.session_id, ctx.api.as_ref()),
            ctx.launch.as_ref(),
        );
        launch_acp(Dialect::Cursor, ctx, program, args, env, Vec::new())
    }
}

/// One question Cursor asked, with the ids its answers go back under.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Asked {
    id: String,
    question: String,
    options: Vec<(String, String)>,
}

/// What Cursor asked, kept to turn the person's answers into its reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Questions {
    /// Asked as a permission request (answers are option ids) instead of `cursor/ask_question`.
    fallback: bool,
    asked: Vec<Asked>,
}

/// What the engine does with a request that is Cursor's own.
#[derive(Debug, Clone, PartialEq)]
pub enum Handled {
    /// Answer at once.
    Reply(Value),
    /// A plan: accepted, and shown to the person.
    Plan { reply: Value, text: String },
    /// Put to the person; the reply waits for the answers.
    Ask {
        questions: Vec<PermissionQuestion>,
        keep: Questions,
    },
}

#[derive(Deserialize)]
struct AskParams {
    questions: Vec<AskQuestion>,
}

#[derive(Deserialize)]
struct AskQuestion {
    id: String,
    prompt: String,
    #[serde(default, rename = "allowMultiple")]
    allow_multiple: Option<bool>,
    options: Vec<AskOption>,
}

#[derive(Deserialize)]
struct AskOption {
    id: String,
    label: String,
}

#[derive(Deserialize)]
struct PlanParams {
    plan: Option<String>,
    overview: Option<String>,
}

/// Cursor's own requests. `None` is not one of them: the engine treats it as any ACP request.
pub fn classify(method: &str, params: &Value) -> Option<std::result::Result<Handled, String>> {
    if REPORTS.contains(&method) {
        return Some(Ok(Handled::Reply(json!({}))));
    }
    match method {
        ASK_QUESTION => Some(ask_question(params)),
        CREATE_PLAN => Some(create_plan(params)),
        "session/request_permission" => fallback_question(params).map(Ok),
        _ => None,
    }
}

fn ask_question(params: &Value) -> std::result::Result<Handled, String> {
    let parsed: AskParams = serde_json::from_value(params.clone())
        .map_err(|_| "Invalid agent question request".to_string())?;
    if parsed.questions.is_empty() || parsed.questions.iter().any(|q| q.options.is_empty()) {
        return Err("Invalid agent question request".into());
    }
    let questions = parsed
        .questions
        .iter()
        .map(|question| PermissionQuestion {
            question: question.prompt.clone(),
            header: String::new(),
            options: question
                .options
                .iter()
                .map(|option| QuestionOption {
                    label: option.label.clone(),
                    description: String::new(),
                })
                .collect(),
            multi_select: question.allow_multiple.unwrap_or(false),
        })
        .collect();
    let asked = parsed
        .questions
        .into_iter()
        .map(|question| Asked {
            id: question.id,
            question: question.prompt,
            options: question
                .options
                .into_iter()
                .map(|option| (option.id, option.label))
                .collect(),
        })
        .collect();
    Ok(Handled::Ask {
        questions,
        keep: Questions {
            fallback: false,
            asked,
        },
    })
}

fn create_plan(params: &Value) -> std::result::Result<Handled, String> {
    let parsed: PlanParams =
        serde_json::from_value(params.clone()).map_err(|_| "Invalid agent plan request")?;
    let text = [parsed.plan, parsed.overview]
        .into_iter()
        .flatten()
        .map(|text| text.trim().to_string())
        .find(|text| !text.is_empty())
        .unwrap_or_else(|| "The agent finished planning without writing a plan.".into());
    // Accepting saves Cursor's plan file and ends the turn; building waits for the next message.
    Ok(Handled::Plan {
        reply: json!({ "outcome": { "outcome": "accepted" } }),
        text,
    })
}

/// A refused question comes back as a permission request whose options are all "allow once" and
/// one of them skips it. Shown as a question, so nothing picks the first answer for the person.
fn fallback_question(params: &Value) -> Option<Handled> {
    let options: Vec<(String, String)> = params
        .get("options")?
        .as_array()?
        .iter()
        .filter_map(|option| {
            Some((
                option.get("optionId")?.as_str()?.to_string(),
                option.get("name")?.as_str()?.to_string(),
            ))
        })
        .collect();
    if !options.iter().any(|(id, _)| id == QUESTION_FALLBACK_SKIP) {
        return None;
    }
    let tool_call = params.get("toolCall");
    let question = tool_call
        .and_then(|call| call.get("content"))
        .and_then(Value::as_array)
        .and_then(|blocks| {
            blocks.iter().find_map(|block| {
                (block.get("type")? == "content")
                    .then(|| block.pointer("/content/text")?.as_str().map(str::to_string))
                    .flatten()
            })
        })
        .or_else(|| {
            tool_call
                .and_then(|call| call.get("title"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "The agent has a question".into());
    Some(Handled::Ask {
        questions: vec![PermissionQuestion {
            question: question.clone(),
            header: String::new(),
            options: options
                .iter()
                .map(|(_, label)| QuestionOption {
                    label: label.clone(),
                    description: String::new(),
                })
                .collect(),
            multi_select: false,
        }],
        keep: Questions {
            fallback: true,
            asked: vec![Asked {
                id: String::new(),
                question,
                options,
            }],
        },
    })
}

/// The reply to a question once the person decided. Dismissing it cancels it; an answer that is
/// none of the offered options (free text) is passed back as the reason the question was skipped,
/// so the agent still reads what the person wrote.
pub fn reply(keep: &Questions, decision: &PermissionDecision) -> Value {
    if !decision.allow {
        return json!({ "outcome": { "outcome": "cancelled" } });
    }
    if keep.fallback {
        let asked = &keep.asked[0];
        let given = decision
            .answers
            .get(&asked.question)
            .map(String::as_str)
            .unwrap_or_default();
        return match asked.options.iter().find(|(_, label)| label == given) {
            Some((id, _)) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
            None => {
                json!({ "outcome": { "outcome": "selected", "optionId": QUESTION_FALLBACK_SKIP } })
            }
        };
    }
    let mut answers = Vec::new();
    let mut free_text = Vec::new();
    for asked in &keep.asked {
        let given = decision
            .answers
            .get(&asked.question)
            .map(String::as_str)
            .unwrap_or_default();
        match chosen(asked, given) {
            Some(ids) => answers.push(json!({ "questionId": asked.id, "selectedOptionIds": ids })),
            None if given.trim().is_empty() => {}
            None => free_text.push(format!("{}: {}", asked.question, given.trim())),
        }
    }
    if !free_text.is_empty() || answers.len() != keep.asked.len() {
        let reason = if free_text.is_empty() {
            "The person skipped the questions.".to_string()
        } else {
            format!(
                "The person answered in their own words. {}",
                free_text.join(" | ")
            )
        };
        return json!({ "outcome": { "outcome": "skipped", "reason": reason } });
    }
    json!({ "outcome": { "outcome": "answered", "answers": answers } })
}

/// The option ids named by an answer: a label, or several joined with a comma.
fn chosen(asked: &Asked, given: &str) -> Option<Vec<String>> {
    let id_of = |label: &str| {
        asked
            .options
            .iter()
            .find(|(_, option)| option == label)
            .map(|(id, _)| id.clone())
    };
    if let Some(id) = id_of(given) {
        return Some(vec![id]);
    }
    let ids: Option<Vec<String>> = given.split(',').map(|part| id_of(part.trim())).collect();
    ids.filter(|ids| !ids.is_empty())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::mpsc::{self, Receiver};
    use std::time::{Duration, Instant};

    use parking_lot::Mutex;

    use super::*;
    use crate::adapters::agents::backend::BackendEvent;
    use crate::domain::PermissionRequestId;
    use crate::domain::ids::TurnId;

    fn ask_params() -> Value {
        json!({
            "title": "Setup",
            "questions": [
                {
                    "id": "db",
                    "prompt": "Which database?",
                    "options": [{ "id": "pg", "label": "Postgres" }, { "id": "lite", "label": "SQLite" }]
                },
                {
                    "id": "extras",
                    "prompt": "Which extras?",
                    "allowMultiple": true,
                    "options": [{ "id": "a", "label": "Auth" }, { "id": "b", "label": "Billing" }]
                }
            ]
        })
    }

    fn decision(allow: bool, answers: &[(&str, &str)]) -> PermissionDecision {
        PermissionDecision {
            request_id: PermissionRequestId::new(),
            allow,
            answers: answers
                .iter()
                .map(|(question, answer)| (question.to_string(), answer.to_string()))
                .collect::<BTreeMap<_, _>>(),
        }
    }

    fn asked(params: Value) -> (Vec<PermissionQuestion>, Questions) {
        match classify(ASK_QUESTION, &params)
            .expect("cursor request")
            .expect("valid")
        {
            Handled::Ask { questions, keep } => (questions, keep),
            other => panic!("expected a question, got {other:?}"),
        }
    }

    #[test]
    fn reports_are_answered_at_once_and_other_methods_are_not_cursors() {
        for method in REPORTS {
            assert_eq!(
                classify(method, &json!({})),
                Some(Ok(Handled::Reply(json!({}))))
            );
        }
        assert!(classify("fs/read_text_file", &json!({})).is_none());
        // An ordinary permission request is the engine's, not a question.
        let ordinary = json!({
            "toolCall": { "toolCallId": "t" },
            "options": [{ "optionId": "allow", "name": "Allow", "kind": "allow_once" }]
        });
        assert!(classify("session/request_permission", &ordinary).is_none());
    }

    #[test]
    fn a_question_request_becomes_questions_for_the_person() {
        let (questions, _) = asked(ask_params());
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].question, "Which database?");
        assert_eq!(questions[0].options[1].label, "SQLite");
        assert!(!questions[0].multi_select);
        assert!(questions[1].multi_select);
    }

    #[test]
    fn a_question_request_without_options_is_invalid() {
        let bad = json!({ "questions": [{ "id": "x", "prompt": "Q?", "options": [] }] });
        assert!(
            classify(ASK_QUESTION, &bad)
                .expect("cursor request")
                .is_err()
        );
        assert!(
            classify(ASK_QUESTION, &json!({ "questions": [] }))
                .expect("cursor request")
                .is_err()
        );
    }

    #[test]
    fn answers_go_back_as_option_ids_by_question() {
        let (_, keep) = asked(ask_params());
        let reply = reply(
            &keep,
            &decision(
                true,
                &[
                    ("Which database?", "SQLite"),
                    ("Which extras?", "Auth, Billing"),
                ],
            ),
        );
        assert_eq!(
            reply,
            json!({ "outcome": {
                "outcome": "answered",
                "answers": [
                    { "questionId": "db", "selectedOptionIds": ["lite"] },
                    { "questionId": "extras", "selectedOptionIds": ["a", "b"] }
                ]
            }})
        );
    }

    #[test]
    fn dismissing_cancels_and_free_text_is_handed_back_as_the_reason() {
        let (_, keep) = asked(ask_params());
        assert_eq!(
            reply(&keep, &decision(false, &[])),
            json!({ "outcome": { "outcome": "cancelled" } })
        );
        let skipped = reply(
            &keep,
            &decision(
                true,
                &[
                    ("Which database?", "Whatever is cheapest"),
                    ("Which extras?", "Auth"),
                ],
            ),
        );
        assert_eq!(skipped["outcome"]["outcome"], "skipped");
        assert!(
            skipped["outcome"]["reason"]
                .as_str()
                .expect("reason")
                .contains("Whatever is cheapest")
        );
        // A question left unanswered is skipped, not answered with the first option.
        let unanswered = reply(&keep, &decision(true, &[("Which database?", "Postgres")]));
        assert_eq!(unanswered["outcome"]["outcome"], "skipped");
    }

    #[test]
    fn a_plan_is_accepted_and_its_text_kept() {
        let handled = classify(
            CREATE_PLAN,
            &json!({ "plan": " 1. Do it ", "overview": "short" }),
        )
        .expect("cursor request")
        .expect("valid");
        assert_eq!(
            handled,
            Handled::Plan {
                reply: json!({ "outcome": { "outcome": "accepted" } }),
                text: "1. Do it".into()
            }
        );
        let empty = classify(CREATE_PLAN, &json!({ "plan": "  " }))
            .expect("cursor request")
            .expect("valid");
        assert!(matches!(empty, Handled::Plan { text, .. } if text.contains("without writing")));
    }

    #[test]
    fn a_permission_request_with_the_skip_option_is_a_question() {
        let params = json!({
            "toolCall": {
                "toolCallId": "q1",
                "title": "Ask",
                "content": [{ "type": "content", "content": { "type": "text", "text": "Use tabs?" } }]
            },
            "options": [
                { "optionId": "yes", "name": "Yes", "kind": "allow_once" },
                { "optionId": QUESTION_FALLBACK_SKIP, "name": "Skip", "kind": "allow_once" }
            ]
        });
        let Some(Handled::Ask { questions, keep }) =
            classify("session/request_permission", &params).map(|handled| handled.expect("valid"))
        else {
            panic!("expected a question");
        };
        assert_eq!(questions[0].question, "Use tabs?");
        assert_eq!(
            reply(&keep, &decision(true, &[("Use tabs?", "Yes")])),
            json!({ "outcome": { "outcome": "selected", "optionId": "yes" } })
        );
        assert_eq!(
            reply(&keep, &decision(true, &[])),
            json!({ "outcome": { "outcome": "selected", "optionId": QUESTION_FALLBACK_SKIP } })
        );
    }

    #[test]
    fn a_missing_cli_is_reported_as_unavailable_with_how_to_fix_it() {
        let backend = CursorBackend::with_command(PathBuf::from("/definitely/not/here"), vec![]);
        // A fixed command is not looked up; availability only checks the usual lookup.
        assert!(backend.availability().is_ok());
        let usual = CursorBackend::new();
        if let Err(message) = usual.availability() {
            assert!(message.contains("ATARAXIA_CURSOR_BIN"));
        }
    }

    struct Harness {
        session: Arc<dyn BackendSession>,
        events: Receiver<BackendEvent>,
    }

    impl Harness {
        fn until(&self, what: &str, done: impl Fn(&BackendEvent) -> bool) -> Vec<BackendEvent> {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut seen = Vec::new();
            while Instant::now() < deadline {
                if let Ok(event) = self.events.recv_timeout(Duration::from_millis(50)) {
                    let stop = done(&event);
                    seen.push(event);
                    if stop {
                        return seen;
                    }
                }
            }
            panic!("timed out waiting for {what}; saw {seen:?}");
        }
    }

    fn start(read_only: bool) -> Result<Harness> {
        start_mock(read_only, None)
    }

    fn start_mock(read_only: bool, flag: Option<&str>) -> Result<Harness> {
        start_mock_with(read_only, flag, None, None, None)
    }

    fn start_mock_with(
        read_only: bool,
        flag: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
        agent: Option<&str>,
    ) -> Result<Harness> {
        let (sender, events) = mpsc::channel();
        let sender = Mutex::new(sender);
        let mut args: Vec<String> = vec![
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/mock_cursor_agent.py"
            )
            .into(),
        ];
        args.extend(flag.map(str::to_string));
        let session =
            CursorBackend::with_command(PathBuf::from("python3"), args).start(BackendContext {
                launch: None,
                read_only,
                session_id: crate::domain::ids::SessionId::new(),
                cwd: std::env::temp_dir(),
                extra_dirs: Vec::new(),
                model: model.map(str::to_string),
                effort: effort.map(str::to_string),
                agent: agent.map(str::to_string),
                resume: None,
                api: None,
                config: super::super::config::AgentConfiguration::default(),
                emit: Arc::new(move |event| {
                    let _ = sender.lock().send(event);
                }),
            })?;
        Ok(Harness { session, events })
    }

    fn done(event: &BackendEvent) -> bool {
        matches!(
            event,
            BackendEvent::TurnDone { .. } | BackendEvent::Error { .. }
        )
    }

    #[test]
    fn the_handshake_tells_cursor_the_model_picker_is_parameterized() {
        let h = start(false).expect("start");
        h.session.prompt(TurnId::new(), "caps").expect("prompt");
        let seen = h.until("turn done", done);
        h.session.shutdown();
        let text: String = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "parameterizedModelPicker=true");
    }

    #[test]
    fn a_question_waits_for_the_person_and_the_answer_reaches_cursor() {
        let h = start(false).expect("start");
        h.session.prompt(TurnId::new(), "ask").expect("prompt");
        let seen = h.until("question", |event| {
            matches!(event, BackendEvent::Permission { .. })
        });
        let Some(BackendEvent::Permission {
            request_id,
            questions,
            ..
        }) = seen.last()
        else {
            panic!("expected a permission");
        };
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].question, "Which database?");
        h.session
            .resolve_permission(&PermissionDecision {
                request_id: *request_id,
                allow: true,
                answers: BTreeMap::from([("Which database?".to_string(), "SQLite".to_string())]),
            })
            .expect("resolve");
        let rest = h.until("turn done", done);
        h.session.shutdown();
        let text: String = rest
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "answered:db=lite");
    }

    #[test]
    fn a_plan_is_shown_and_the_turn_ends() {
        let h = start(false).expect("start");
        h.session.prompt(TurnId::new(), "plan").expect("prompt");
        let seen = h.until("turn done", done);
        h.session.shutdown();
        let text: String = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(text.contains("Ship the feature"), "plan text in {text:?}");
        assert!(
            text.contains("accepted"),
            "cursor saw the acceptance: {text:?}"
        );
    }

    #[test]
    fn a_read_only_session_runs_in_the_plan_mode() {
        let h = start(true).expect("start");
        h.session.prompt(TurnId::new(), "mode").expect("prompt");
        let seen = h.until("turn done", done);
        h.session.shutdown();
        let text: String = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "mode=plan");
    }

    /// What the mock says for `text`, once its turn ends.
    fn answer_to(h: &Harness, text: &str) -> String {
        h.session.prompt(TurnId::new(), text).expect("prompt");
        h.until("turn done", done)
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_read_only_session_stays_read_only_when_its_settings_change() {
        let h = start_mock_with(true, None, None, None, Some("agent")).expect("start");
        assert_eq!(answer_to(&h, "mode"), "mode=plan", "the saved agent wrote");
        assert!(h.session.apply_settings(None, None, None));
        assert_eq!(
            answer_to(&h, "mode"),
            "mode=plan",
            "back to the default mode"
        );
        assert!(h.session.apply_settings(None, None, Some("agent")));
        assert_eq!(answer_to(&h, "mode"), "mode=plan", "a mode that writes");
        assert!(h.session.apply_settings(None, None, Some("ask")));
        assert_eq!(answer_to(&h, "mode"), "mode=ask");
        h.session.shutdown();
    }

    #[test]
    fn effort_reaches_the_levels_of_a_model_with_a_thinking_switch() {
        let h = start_mock_with(false, None, Some("claude"), Some("max"), None).expect("start");
        let options = h.session.options();
        assert_eq!(
            options.efforts,
            ["off", "low", "medium", "high", "xhigh", "max"],
            "the switch must not hide the levels"
        );
        assert_eq!(
            answer_to(&h, "settings"),
            "model=claude effort=max thinking=true"
        );
        assert!(h.session.apply_settings(Some("claude"), Some("off"), None));
        assert_eq!(
            answer_to(&h, "settings"),
            "model=claude effort=max thinking=false"
        );
        assert!(h.session.apply_settings(Some("claude"), None, None));
        assert_eq!(
            answer_to(&h, "settings"),
            "model=claude effort=high thinking=false"
        );
        h.session.shutdown();
    }

    #[test]
    fn effort_follows_the_option_each_model_names_its_levels_with() {
        let h = start(false).expect("start");
        assert!(h.session.options().efforts.is_empty(), "auto has no levels");
        assert!(h.session.apply_settings(Some("gpt-5"), Some("high"), None));
        assert_eq!(
            h.session.options().efforts,
            ["none", "low", "medium", "high", "extra-high"]
        );
        assert_eq!(answer_to(&h, "settings"), "model=gpt-5 reasoning=high");
        // Default is the model's own level, which it reported when it was picked.
        assert!(h.session.apply_settings(Some("gpt-5"), None, None));
        assert_eq!(answer_to(&h, "settings"), "model=gpt-5 reasoning=medium");
        // A level of another model is not sent: Cursor would refuse it.
        assert!(
            h.session
                .apply_settings(Some("claude"), Some("extra-high"), None)
        );
        assert_eq!(
            answer_to(&h, "settings"),
            "model=claude effort=high thinking=false"
        );
        assert!(h.session.apply_settings(None, None, None));
        assert_eq!(answer_to(&h, "settings"), "model=auto");
        h.session.shutdown();
    }

    #[test]
    fn a_read_only_session_is_refused_when_cursor_offers_no_read_only_mode() {
        let h = start_mock(true, Some("--no-read-only")).expect("spawn");
        let seen = h.until("refusal", |event| {
            matches!(event, BackendEvent::Error { .. })
        });
        let Some(BackendEvent::Error { message }) = seen.last() else {
            panic!("expected an error");
        };
        assert!(message.contains("read-only"), "{message}");
        // The session never opened, so nothing reaches Cursor.
        // Refused at once when the process is gone, or answered with the reason while it ends.
        let after = match h.session.prompt(TurnId::new(), "mode") {
            Ok(()) => h.until("prompt refused", done),
            Err(_) => Vec::new(),
        };
        assert!(
            !after
                .iter()
                .any(|event| matches!(event, BackendEvent::Delta { .. })),
            "a session that must not write answered: {after:?}"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while h.session.is_alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!h.session.is_alive());
    }

    #[test]
    fn the_chat_opens_before_cursor_opens_its_session_and_the_prompt_waits_for_it() {
        let began = Instant::now();
        let h = start_mock(false, Some("--slow-session")).expect("start");
        assert!(
            began.elapsed() < Duration::from_millis(800),
            "start waited for session/new: {:?}",
            began.elapsed()
        );
        h.session.prompt(TurnId::new(), "hello").expect("prompt");
        let seen = h.until("turn done", done);
        assert!(
            seen.iter()
                .any(|event| matches!(event, BackendEvent::TurnDone { ok: true, .. })),
            "{seen:?}"
        );
        assert!(
            began.elapsed() >= Duration::from_secs(1),
            "answered before the session was open"
        );
        // The settings arrive once the session is open.
        assert_eq!(h.session.options().agents.len(), 3);
        h.session.shutdown();
    }

    #[test]
    fn a_session_that_fails_to_open_says_why_once_and_ends_the_process() {
        let h = start_mock(false, Some("--failing-session")).expect("start");
        let seen = h.until("error", |event| matches!(event, BackendEvent::Error { .. }));
        let Some(BackendEvent::Error { message }) = seen.last() else {
            panic!("expected an error");
        };
        assert!(message.contains("no workspace"), "{message}");
        let deadline = Instant::now() + Duration::from_secs(5);
        while h.session.is_alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !h.session.is_alive(),
            "the process should end for a restart"
        );
        // Its exit is not reported a second time.
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            !h.events
                .try_iter()
                .any(|event| matches!(event, BackendEvent::Error { .. })),
            "the failure was reported twice"
        );
    }

    fn start_real(read_only: bool, cwd: &std::path::Path) -> Harness {
        let (sender, events) = mpsc::channel();
        let sender = Mutex::new(sender);
        let session = CursorBackend::new()
            .start(BackendContext {
                launch: None,
                read_only,
                session_id: crate::domain::ids::SessionId::new(),
                cwd: cwd.to_path_buf(),
                extra_dirs: Vec::new(),
                model: None,
                effort: None,
                agent: None,
                resume: None,
                api: None,
                config: super::super::config::AgentConfiguration::default(),
                emit: Arc::new(move |event| {
                    let _ = sender.lock().send(event);
                }),
            })
            .expect("start the real cursor-agent");
        Harness { session, events }
    }

    fn deltas(seen: &[BackendEvent]) -> String {
        seen.iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    /// Only opens the session: no prompt, so nothing is sent to a model and no setting changes.
    #[test]
    #[ignore = "needs the cursor-agent CLI and a login"]
    fn the_real_cursor_opens_a_session_with_remote_and_local_mcp_servers() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = super::super::config::AgentConfiguration::default();
        // The shapes the app passes: its own server (with a token), a remote one without any
        // headers (the CLI refused the session for it: "Invalid params") and a local one.
        for (name, server) in [
            (
                "ataraxia",
                json!({ "url": "http://127.0.0.1:9/mcp", "headers": { "Authorization": "Bearer x" } }),
            ),
            ("remote", json!({ "url": "http://127.0.0.1:9/remote" })),
            (
                "local",
                json!({ "command": "npx", "args": ["a-server", "--flag"] }),
            ),
        ] {
            config.mcp_servers.insert(name.into(), server);
        }
        let (sender, events) = mpsc::channel();
        let sender = Mutex::new(sender);
        let began = Instant::now();
        let session = CursorBackend::new()
            .start(BackendContext {
                launch: None,
                read_only: false,
                session_id: crate::domain::ids::SessionId::new(),
                cwd: dir.path().canonicalize().unwrap(),
                extra_dirs: Vec::new(),
                model: None,
                effort: None,
                agent: None,
                resume: None,
                api: None,
                config,
                emit: Arc::new(move |event| {
                    let _ = sender.lock().send(event);
                }),
            })
            .expect("the real cursor-agent starts");
        let started = began.elapsed();
        // The session opens in the background; its options are listed once it has.
        let options = session.options();
        eprintln!(
            "started in {started:?}, session open in {:?}",
            began.elapsed()
        );
        let failure = events.try_iter().find_map(|event| match event {
            BackendEvent::Error { message } => Some(message),
            _ => None,
        });
        session.shutdown();
        assert_eq!(
            failure, None,
            "the session did not open with these MCP servers"
        );
        assert!(
            !options.models.is_empty(),
            "no models once the session opened"
        );
    }

    #[test]
    #[ignore = "needs the cursor-agent CLI and a login"]
    fn the_real_cursor_lists_models_and_modes_and_answers_a_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let h = start_real(false, &dir.path().canonicalize().unwrap());
        let options = h.session.options();
        let models: Vec<_> = options.models.iter().map(|m| m.id.as_str()).collect();
        let agents: Vec<_> = options.agents.iter().map(|a| a.id.as_str()).collect();
        eprintln!(
            "models: {} ({:?}...)",
            models.len(),
            &models[..models.len().min(5)]
        );
        eprintln!(
            "default: {:?}, efforts: {:?}, agents: {agents:?}",
            options.default_model, options.efforts
        );
        assert!(models.contains(&"default"));
        assert!(agents.contains(&"plan") && agents.contains(&"ask"));
        h.session
            .prompt(TurnId::new(), "Reply with exactly the word: pong")
            .expect("prompt");
        let seen = h.until("turn done", done);
        h.session.shutdown();
        eprintln!("answer: {:?}", deltas(&seen));
        assert!(deltas(&seen).to_lowercase().contains("pong"));
        assert!(
            seen.iter()
                .any(|event| matches!(event, BackendEvent::TurnDone { ok: true, .. }))
        );
    }

    #[test]
    #[ignore = "needs the cursor-agent CLI and a login"]
    fn the_real_cursor_in_a_read_only_session_does_not_write() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let h = start_real(true, &cwd);
        h.session
            .prompt(
                TurnId::new(),
                "Create a file named probe.txt in the current directory containing the word hi.",
            )
            .expect("prompt");
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            let Ok(event) = h.events.recv_timeout(Duration::from_millis(100)) else {
                continue;
            };
            // Writing would ask first; a read-only session must never get that far.
            if let BackendEvent::Permission {
                tool_name,
                detail,
                request_id,
                ..
            } = &event
            {
                eprintln!("permission asked: {tool_name} / {detail}");
                let _ = h.session.resolve_permission(&PermissionDecision {
                    request_id: *request_id,
                    allow: false,
                    answers: BTreeMap::new(),
                });
            }
            let stop = done(&event);
            seen.push(event);
            if stop {
                break;
            }
        }
        h.session.shutdown();
        eprintln!("answer: {:?}", deltas(&seen));
        assert!(
            !cwd.join("probe.txt").exists(),
            "a read-only session wrote a file"
        );
    }

    #[test]
    #[ignore = "needs the cursor-agent CLI and a login"]
    fn the_real_cursor_switches_model_and_reports_its_efforts() {
        let dir = tempfile::tempdir().unwrap();
        let h = start_real(false, &dir.path().canonicalize().unwrap());
        let own = h.session.options().default_model;
        // Levels only, a thinking switch next to levels, and the switch alone. The effort is
        // left alone: Cursor keeps each model's reasoning for the whole account too.
        for (model, offered) in [
            ("gpt-5.5", "extra-high"),
            ("claude-opus-4-8", "max"),
            ("claude-sonnet-4-5", "on"),
        ] {
            let applied = h.session.apply_settings(Some(model), None, None);
            let options = h.session.options();
            eprintln!("{model}: applied={applied} efforts={:?}", options.efforts);
            assert!(applied);
            assert!(options.efforts.iter().any(|effort| effort == offered));
        }
        // Cursor keeps the chosen model for the whole account, so put the original one back.
        assert!(h.session.apply_settings(None, None, None));
        assert_eq!(
            h.session.options().default_model,
            own,
            "the account's own model was not restored"
        );
        h.session.shutdown();
    }

    /// Runs one prompt against the real CLI, answering what it asks the way `answer` says.
    fn drive_real(
        h: &Harness,
        prompt: &str,
        answer: impl Fn(&BackendEvent) -> Option<PermissionDecision>,
    ) -> Vec<BackendEvent> {
        h.session.prompt(TurnId::new(), prompt).expect("prompt");
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(150);
        while Instant::now() < deadline {
            let Ok(event) = h.events.recv_timeout(Duration::from_millis(100)) else {
                continue;
            };
            if let Some(decision) = answer(&event) {
                h.session.resolve_permission(&decision).expect("resolve");
            }
            let stop = done(&event);
            seen.push(event);
            if stop {
                return seen;
            }
        }
        panic!("the real cursor-agent did not finish; saw {seen:?}");
    }

    #[test]
    #[ignore = "needs the cursor-agent CLI and a login"]
    fn the_real_cursor_asks_before_a_shell_command_and_runs_it_once_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let h = start_real(false, &cwd);
        let asked = std::sync::atomic::AtomicUsize::new(0);
        let seen = drive_real(
            &h,
            "Run exactly this shell command once and nothing else: echo hi > shell.txt",
            |event| match event {
                BackendEvent::Permission {
                    request_id,
                    tool_name,
                    detail,
                    ..
                } => {
                    eprintln!("permission: {tool_name} / {detail}");
                    asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Some(PermissionDecision {
                        request_id: *request_id,
                        allow: true,
                        answers: BTreeMap::new(),
                    })
                }
                _ => None,
            },
        );
        h.session.shutdown();
        eprintln!("answer: {:?}", deltas(&seen));
        eprintln!(
            "permissions asked: {}",
            asked.load(std::sync::atomic::Ordering::SeqCst)
        );
        assert!(
            asked.load(std::sync::atomic::Ordering::SeqCst) > 0,
            "no permission was asked"
        );
        assert!(
            std::fs::read_to_string(cwd.join("shell.txt")).is_ok_and(|text| text.contains("hi")),
            "the allowed command did not run"
        );
        assert!(seen.iter().any(|e| matches!(e, BackendEvent::Tool { .. })));
    }

    #[test]
    #[ignore = "needs the cursor-agent CLI and a login"]
    fn the_real_cursor_denied_shell_command_is_answered_and_the_turn_ends() {
        // Cursor may then do the same with its edit tool, which it never asks about, so what is
        // checked is that the refusal reached it and the turn still ended.
        let dir = tempfile::tempdir().unwrap();
        let h = start_real(false, &dir.path().canonicalize().unwrap());
        let refused = std::sync::atomic::AtomicUsize::new(0);
        let seen = drive_real(
            &h,
            "Run exactly this shell command once and nothing else: echo hi > shell.txt",
            |event| match event {
                BackendEvent::Permission { request_id, .. } => {
                    refused.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Some(PermissionDecision {
                        request_id: *request_id,
                        allow: false,
                        answers: BTreeMap::new(),
                    })
                }
                _ => None,
            },
        );
        h.session.shutdown();
        eprintln!("answer: {:?}", deltas(&seen));
        assert!(refused.load(std::sync::atomic::Ordering::SeqCst) > 0);
        assert!(
            seen.iter()
                .any(|event| matches!(event, BackendEvent::TurnDone { .. }))
        );
    }
}
