//! Follows a background subagent through its transcript file.
//!
//! Claude Code runs a background subagent detached from the stream it prints, but reports an
//! `output_file`: a symlink to the subagent's own transcript, which grows while it works. Each
//! line is a JSON entry (`user` / `assistant`, with `message.content` blocks), so the subagent's
//! conversation can be rebuilt by reading new lines as they appear.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::backend::truncate_output;
use super::backend::{BackendEvent, Emitter};
use super::claude::{input_text, tool_result_text};
use crate::domain::{SubagentUpdate, ToolCallId};

const POLL: Duration = Duration::from_millis(150);
/// How long to wait for the file to show up before giving up.
const APPEAR_TIMEOUT: Duration = Duration::from_secs(30);

/// What has been seen so far, so entries turn into updates exactly once.
#[derive(Default)]
pub struct TailState {
    tools: HashMap<String, ToolCallId>,
    seen_prompt: bool,
    last_was_text: bool,
}

impl TailState {
    /// For a tail that resumes mid-file: the prompt was already shown.
    pub fn resuming() -> Self {
        Self {
            seen_prompt: true,
            ..Self::default()
        }
    }
}

/// Turns one transcript entry into subagent updates.
pub fn parse_entry(entry: &Value, state: &mut TailState) -> Vec<SubagentUpdate> {
    let mut updates = Vec::new();
    let content = entry.pointer("/message/content");
    match entry.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            for block in content.and_then(Value::as_array).into_iter().flatten() {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = block
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if text.trim().is_empty() {
                            continue;
                        }
                        let separator = if state.last_was_text { "\n\n" } else { "" };
                        updates.push(SubagentUpdate::Delta {
                            text: format!("{separator}{text}"),
                        });
                        state.last_was_text = true;
                    }
                    Some("tool_use") => {
                        let Some(id) = block.get("id").and_then(Value::as_str) else {
                            continue;
                        };
                        if state.tools.contains_key(id) {
                            continue;
                        }
                        let call_id = ToolCallId::new();
                        state.tools.insert(id.to_string(), call_id);
                        state.last_was_text = false;
                        updates.push(SubagentUpdate::Tool {
                            call_id,
                            name: block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string(),
                            input: input_text(block.get("input")).unwrap_or_default(),
                        });
                    }
                    _ => {}
                }
            }
            if entry
                .pointer("/message/stop_reason")
                .and_then(Value::as_str)
                == Some("end_turn")
            {
                updates.push(SubagentUpdate::Done { ok: true });
            }
        }
        Some("user") => match content {
            Some(Value::String(text)) => {
                if !state.seen_prompt && !text.trim().is_empty() {
                    state.seen_prompt = true;
                    updates.push(SubagentUpdate::User { text: text.clone() });
                }
            }
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("tool_result") => {
                            let Some(call_id) = block
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .and_then(|id| state.tools.get(id))
                            else {
                                continue;
                            };
                            state.last_was_text = false;
                            updates.push(SubagentUpdate::ToolResult {
                                call_id: *call_id,
                                output: truncate_output(tool_result_text(block.get("content"))),
                                ok: !block
                                    .get("is_error")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                            });
                        }
                        Some("text") if !state.seen_prompt => {
                            let text = block
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            if !text.trim().is_empty() {
                                state.seen_prompt = true;
                                updates.push(SubagentUpdate::User {
                                    text: text.to_string(),
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        },
        _ => {}
    }
    updates
}

pub struct TailSpec {
    pub path: PathBuf,
    pub id: String,
    pub title: String,
    pub emit: Emitter,
    pub stop: Arc<AtomicBool>,
    /// Start at the end of the file instead of the beginning (a tail restarted after a message).
    pub from_end: bool,
}

/// Follows the file on its own thread until `stop` is set or the subagent reports it is done.
pub fn spawn_tail(spec: TailSpec) {
    thread::spawn(move || run(spec));
}

fn run(spec: TailSpec) {
    let emit = |update: SubagentUpdate| {
        (spec.emit)(BackendEvent::Subagent {
            id: spec.id.clone(),
            title: spec.title.clone(),
            update,
        });
    };
    let started = Instant::now();
    let mut offset = 0u64;
    let mut state = if spec.from_end {
        TailState::resuming()
    } else {
        TailState::default()
    };
    let mut pending: Vec<u8> = Vec::new();
    let mut positioned = !spec.from_end;

    while !spec.stop.load(Ordering::SeqCst) {
        match File::open(&spec.path) {
            Ok(mut file) => {
                if !positioned {
                    offset = file.metadata().map(|meta| meta.len()).unwrap_or(0);
                    positioned = true;
                }
                if file.seek(SeekFrom::Start(offset)).is_ok() {
                    let mut chunk = Vec::new();
                    if let Ok(read) = file.read_to_end(&mut chunk) {
                        offset += read as u64;
                        pending.extend_from_slice(&chunk);
                    }
                }
                // Only whole lines: the writer may be in the middle of one.
                while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = pending.drain(..=end).collect();
                    let Ok(entry) = serde_json::from_slice::<Value>(&line) else {
                        continue;
                    };
                    for update in parse_entry(&entry, &mut state) {
                        let done = matches!(update, SubagentUpdate::Done { .. });
                        emit(update);
                        if done {
                            return;
                        }
                    }
                }
            }
            Err(_) => {
                if started.elapsed() > APPEAR_TIMEOUT {
                    emit(SubagentUpdate::Done { ok: false });
                    return;
                }
            }
        }
        thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(entries: &[Value]) -> Vec<SubagentUpdate> {
        let mut state = TailState::default();
        entries
            .iter()
            .flat_map(|entry| parse_entry(entry, &mut state))
            .collect()
    }

    #[test]
    fn the_prompt_then_a_tool_then_the_answer_become_a_conversation() {
        let updates = parse(&[
            json!({"type":"user","isSidechain":true,"message":{"role":"user","content":"Explore the repo"}}),
            json!({"type":"assistant","message":{"role":"assistant","content":[
                {"type":"tool_use","id":"t1","name":"Grep","input":{"pattern":"main"}}]}}),
            json!({"type":"user","message":{"role":"user","content":[
                {"type":"tool_result","tool_use_id":"t1","content":"src/main.rs"}]}}),
            json!({"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[
                {"type":"text","text":"One entry point."}]}}),
        ]);
        assert!(matches!(&updates[0], SubagentUpdate::User { text } if text == "Explore the repo"));
        let SubagentUpdate::Tool {
            call_id,
            name,
            input,
        } = &updates[1]
        else {
            panic!("expected a tool, got {:?}", updates[1]);
        };
        assert_eq!(name, "Grep");
        assert!(input.contains("main"));
        assert!(matches!(
            &updates[2],
            SubagentUpdate::ToolResult { call_id: id, output, ok: true }
                if id == call_id && output == "src/main.rs"
        ));
        assert!(
            matches!(&updates[3], SubagentUpdate::Delta { text } if text == "One entry point.")
        );
        assert!(matches!(&updates[4], SubagentUpdate::Done { ok: true }));
    }

    #[test]
    fn only_the_first_user_text_is_the_prompt_and_thinking_is_skipped() {
        let updates = parse(&[
            json!({"type":"user","message":{"role":"user","content":"first"}}),
            json!({"type":"user","message":{"role":"user","content":"a later message"}}),
            json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"}]}}),
            json!({"type":"fork-context-ref","agentId":"x"}),
        ]);
        assert_eq!(updates.len(), 1);
    }

    #[test]
    fn consecutive_text_entries_are_separated_and_errors_are_flagged() {
        let updates = parse(&[
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"One."}]}}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"Two."}]}}),
            json!({"type":"assistant","message":{"content":[
                {"type":"tool_use","id":"t9","name":"Bash","input":{}}]}}),
            json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"t9","content":"boom","is_error":true}]}}),
        ]);
        assert!(matches!(&updates[0], SubagentUpdate::Delta { text } if text == "One."));
        assert!(matches!(&updates[1], SubagentUpdate::Delta { text } if text == "\n\nTwo."));
        assert!(matches!(
            updates.last(),
            Some(SubagentUpdate::ToolResult { ok: false, .. })
        ));
    }

    #[test]
    fn a_resumed_tail_does_not_replay_the_prompt() {
        let mut state = TailState::resuming();
        let updates = parse_entry(
            &json!({"type":"user","message":{"role":"user","content":"a message sent to it"}}),
            &mut state,
        );
        assert!(updates.is_empty());
    }

    #[test]
    fn unknown_tool_results_are_ignored() {
        let updates = parse(&[json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"never-seen","content":"x"}]}})]);
        assert!(updates.is_empty());
    }
}
