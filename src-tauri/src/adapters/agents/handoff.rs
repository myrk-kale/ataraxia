//! The record an agent inherits when it takes over a conversation it has no memory of: the user
//! switched providers or accounts mid-chat, or the agent could not pick its own conversation up
//! again (the app was restarted, its process died, its model changed).
//!
//! The whole exchange is written to a text file and the new agent is told, once, that it continues
//! that conversation and may read parts of it.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use crate::domain::ids::SessionId;
use crate::domain::{
    ChatItem, ChatRole, Error, ErrorCode, Result, SubagentRecord, SubagentStatus, ToolCallRecord,
};

/// Where a chat's handoff file lives: one file per chat, rewritten on each switch.
pub fn handoff_path(dir: &Path, session: &SessionId) -> PathBuf {
    dir.join(format!("{}.txt", session.0))
}

fn tool_entry(out: &mut String, label: &str, tool: &ToolCallRecord) {
    let _ = writeln!(out, "[{label}] {} ({})", tool.name, tool.status.as_str());
    if !tool.input.trim().is_empty() {
        let _ = writeln!(out, "input:\n{}", tool.input.trim());
    }
    if let Some(output) = tool
        .output
        .as_deref()
        .filter(|text| !text.trim().is_empty())
    {
        let _ = writeln!(out, "output:\n{}", output.trim());
    }
    out.push('\n');
}

fn items_into(out: &mut String, items: &[ChatItem], who: (&str, &str, &str)) {
    for item in items {
        match item {
            ChatItem::Message(message) if !message.text.trim().is_empty() => {
                let label = match message.role {
                    ChatRole::User => who.0,
                    ChatRole::Assistant => who.1,
                    ChatRole::System => "system",
                };
                let _ = writeln!(out, "[{label}]\n{}\n", message.text.trim());
            }
            ChatItem::Tool(tool) => tool_entry(out, who.2, tool),
            ChatItem::Message(_) => {}
        }
    }
}

/// The conversation as plain text, in order, every entry labelled by who it came from: the user,
/// the agent, a tool, or a subagent.
pub fn render(from_provider: &str, items: &[ChatItem], subagents: &[SubagentRecord]) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "Conversation between the user and a coding agent ({from_provider}), up to the point where a new agent took over.\nEvery entry is labelled: [user], [agent], [tool], [subagent: <title>] with its own [user], [agent] and [tool] entries.\n"
    );
    items_into(&mut out, items, ("user", "agent", "tool"));
    for subagent in subagents {
        let _ = writeln!(
            out,
            "---- subagent: {} ({}) ----\n",
            if subagent.title.trim().is_empty() {
                &subagent.id
            } else {
                &subagent.title
            },
            match subagent.status {
                SubagentStatus::Running => "running",
                SubagentStatus::Done => "done",
                SubagentStatus::Failed => "failed",
            }
        );
        let label = format!("subagent: {}", subagent.title.trim());
        items_into(
            &mut out,
            &subagent.items,
            (
                &format!("{label} / user"),
                &format!("{label} / agent"),
                &format!("{label} / tool"),
            ),
        );
    }
    out
}

pub fn write(path: &Path, text: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    }
    std::fs::write(path, text).map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
}

/// What the new agent reads ahead of the user's next message.
pub fn preamble(path: &Path) -> String {
    format!(
        "[Context from Ataraxia] This chat continues a conversation that was already under way: the user talked with an agent before (another one, or this one before it restarted), and you start without its memory. What was said and done (user, agent, tool and subagent entries, in order) is saved at {}. It can be long, so do not read it all: read the parts you need, the end first, or search it for the words of the message below. If the message below needs nothing from before, just answer it.\n\n",
        path.display()
    )
}
