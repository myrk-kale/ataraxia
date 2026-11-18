//! What the agent of a chat is told about Ataraxia, and where it can read more.
//!
//! The prompt is short on purpose. It says what the app is, that nothing is to be generated
//! unasked, and to offer it after a review or after writing code. The detail lives in a guide on
//! disk, which the agent reads only once the developer has said yes, as a skill is read.

use std::path::{Path, PathBuf};

use crate::domain::{Error, ErrorCode, Result};

/// The guide's files, shipped inside the app and written to the data folder at start.
const FILES: &[(&str, &str)] = &[
    ("README.md", include_str!("../../../guide/README.md")),
    ("decisions.md", include_str!("../../../guide/decisions.md")),
    ("flow.md", include_str!("../../../guide/flow.md")),
    ("svg.md", include_str!("../../../guide/svg.md")),
    ("review.md", include_str!("../../../guide/review.md")),
    ("schedule.md", include_str!("../../../guide/schedule.md")),
    ("tasks.md", include_str!("../../../guide/tasks.md")),
    ("queue.md", include_str!("../../../guide/queue.md")),
    ("api.md", include_str!("../../../guide/api.md")),
];

/// Writes the guide into `dir` (replacing an older copy) and returns the page to start from.
pub fn install(dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(dir).map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    for (name, text) in FILES {
        std::fs::write(dir.join(name), text)
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    }
    Ok(dir.join("README.md"))
}

/// Said to the agent ahead of the first message of a chat, once per agent process.
pub fn preamble(index: &Path) -> String {
    format!(
        "[Context from Ataraxia] This chat runs inside Ataraxia, an app where the developer reviews the code you write: a review queue of changed components ranked by priority, Decisions (choices that deserve their verdict) and Flow diagrams.\n\
         - Never generate or record any of these on your own.\n\
         - When you finish reviewing code, or writing or changing code, end your reply with one short question, in the developer's language, asking whether they want you to generate decisions, a flow diagram, review comments or priorities. Do not ask after an exchange that neither reviewed nor changed code.\n\
         - Write a TLDR last. After reviewing or changing code, the last thing in your reply, right before that question, is a TLDR of two to four short lines in the developer's language: what changed, why, and what to check first to validate it. Skip it after an exchange that neither reviewed nor changed code.\n\
         - Only once the developer says yes, or asks for any of them, read {} (it says what each is and how to call the API), then do what they chose. Do not read it before.\n\
         - A diagram asked for with no kind is a Mermaid diagram (a mermaid code block in your reply). Make a Flow diagram (saved in Ataraxia's Flow tab) only when the developer says Flow, and do not ask which.\n\
         - For Mermaid flowcharts, use the animated renderer's compatible subset: `flowchart TD` or `flowchart LR`, simple node IDs and quoted plain-text labels, and `-->` links with optional `|label|`. Avoid HTML, backticks, escaped newlines, styling, subgraphs and special link syntax; keep labels short and diagrams under 60 nodes and 100 edges. Do not replace an explicitly requested non-flowchart diagram type. Rendering also depends on device support.\n\
         - When explaining structure, relations or three or more things compared, or when asked for an SVG or mind map, add an SVG in a ```svg code block (the chat shows an image). Before your first in a chat, read {} (how, and when not).\n\
         - To come back to something later (a deploy still running, a retry in minutes), do not use cron, wakeup or /loop tools: they are off. {} says how.\n\
         - The developer queues messages while you work; they are sent when your turn ends. If something you were asked to do is left undone (a blocker, a failure you could not fix, a question only they can answer), hold their queue before you end your turn, so the next message does not run on top of it: `curl -sS -X POST \"$ATARAXIA_API_URL/v1/queue/pause\" -H \"Authorization: Bearer $ATARAXIA_API_TOKEN\" -H 'Content-Type: application/json' -d '{{\"reason\": \"what is pending\"}}'`. Then say what is pending. Do not pause when the work is done. {} has details.\n\
         - The way to act on Ataraxia is its local HTTP API, called from bash with curl as that guide explains, using $ATARAXIA_API_URL, $ATARAXIA_API_TOKEN and $ATARAXIA_SESSION_ID from your environment. There are no tools for it.\n\
         - The developer keeps numbered tasks in Ataraxia. When they name one (\"#12\", \"task 12\"), fetch it with `curl -sS \"$ATARAXIA_API_URL/v1/tasks/12\" -H \"Authorization: Bearer $ATARAXIA_API_TOKEN\"` and work from its title and notes; {} has details. Do not guess a task from its number.\n\
         The developer's message follows.\n\n",
        index.display(),
        index.with_file_name("svg.md").display(),
        index.with_file_name("schedule.md").display(),
        index.with_file_name("queue.md").display(),
        index.with_file_name("tasks.md").display()
    )
}

/// What the agent is told when its chat belongs to a workspace of several repositories: where
/// each one is, and that API paths name the repository. Empty for a workspace of one.
pub fn workspace_note(members: &[(String, PathBuf)]) -> String {
    if members.len() < 2 {
        return String::new();
    }
    let mut out = format!(
        "[Workspace] This chat covers {} repositories. You may read and change any of them, using absolute paths outside your working directory:\n",
        members.len()
    );
    for (index, (name, path)) in members.iter().enumerate() {
        out.push_str(&format!(
            "- {name}: {}{}\n",
            path.display(),
            if index == 0 {
                " (your working directory)"
            } else {
                ""
            }
        ));
    }
    out.push_str(
        "When you name a file to Ataraxia (decisions, flow diagrams, comments), write it as <repository>/<path> for any repository except the first.\n\n",
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installing_writes_every_page_and_the_prompt_points_at_the_index() {
        let dir = std::env::temp_dir().join(format!("ataraxia-guide-{}", uuid::Uuid::new_v4()));
        let index = install(&dir).expect("install");
        assert!(index.ends_with("README.md"));
        for (name, text) in FILES {
            assert_eq!(
                &std::fs::read_to_string(dir.join(name)).expect("read"),
                text
            );
        }
        let prompt = preamble(&index);
        assert!(prompt.contains(&index.display().to_string()));
        assert!(prompt.contains("Never generate"));
        assert!(prompt.contains("one short question"));
        assert!(prompt.contains("ATARAXIA_API_URL"));
        // Every agent is told, in the prompt itself, when and how to hold the developer's queue.
        assert!(prompt.contains("/v1/queue/pause"));
        assert!(prompt.contains("hold their queue"));
        assert!(prompt.contains("Do not pause when the work is done"));
        assert!(prompt.contains("Flow diagram") && prompt.contains("Mermaid diagram"));
        // Drawings: the fence to use, and the page that teaches how to make them well.
        assert!(prompt.contains("```svg"));
        assert!(prompt.contains(&index.with_file_name("svg.md").display().to_string()));
        assert!(prompt.contains("Avoid HTML"));
        // The TLDR comes last, ahead of the closing question, and tasks can be fetched by number.
        assert!(prompt.contains("Write a TLDR last"));
        assert!(prompt.contains("/v1/tasks/12"));
        assert!(prompt.contains("Do not replace an explicitly requested non-flowchart"));
        // The pages the index names all exist.
        let readme = std::fs::read_to_string(&index).expect("index");
        for (name, _) in FILES.iter().filter(|(name, _)| *name != "README.md") {
            assert!(readme.contains(name), "{name} is not listed in the index");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_workspace_of_several_repositories_is_listed_and_one_alone_is_not_mentioned() {
        let one = vec![("app".to_string(), PathBuf::from("/w/app"))];
        assert_eq!(workspace_note(&one), "");
        let two = vec![
            ("app".to_string(), PathBuf::from("/w/app")),
            ("api".to_string(), PathBuf::from("/w/api")),
        ];
        let text = workspace_note(&two);
        assert!(text.contains("2 repositories"));
        assert!(text.contains("- app: /w/app (your working directory)"));
        assert!(text.contains("- api: /w/api\n"));
        assert!(text.contains("<repository>/<path>"));
    }

    #[test]
    fn a_request_for_a_diagram_with_no_kind_is_a_mermaid_diagram_and_flow_only_when_it_is_named() {
        let text = preamble(Path::new("/data/guide/README.md"));
        let line = text
            .lines()
            .find(|line| line.contains("asked for with no kind"))
            .expect("a line about diagrams");
        assert!(line.contains("is a Mermaid diagram"));
        assert!(line.contains("only when the developer says Flow"));
        // It never asks which one: the default answers that.
        assert!(line.contains("do not ask which"));
        assert!(!line.contains("ask first"));
    }

    #[test]
    fn the_svg_guide_teaches_with_drawings_that_are_well_formed_xml() {
        let (_, text) = FILES
            .iter()
            .find(|(name, _)| *name == "svg.md")
            .expect("the svg page");
        let drawings: Vec<&str> = text
            .split("```svg\n")
            .skip(1)
            .filter_map(|part| part.split("```").next())
            .collect();
        assert!(drawings.len() >= 2, "the page shows what to make");
        for drawing in drawings {
            assert!(
                drawing
                    .trim_start()
                    .starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 800 ")
            );
            assert!(drawing.contains("<title>") && drawing.contains("<desc>"));
            assert!(drawing.trim_end().ends_with("</svg>"));
            // Every tag that opens is closed or closes itself.
            let opened = drawing.matches("<rect").count()
                + drawing.matches("<path").count()
                + drawing.matches("<text").count();
            let closed = drawing.matches("/>").count() + drawing.matches("</text>").count();
            assert!(closed >= opened);
        }
    }

    #[test]
    fn the_prompt_stays_short() {
        let text = preamble(Path::new("/data/guide/README.md"));
        assert!(
            text.split_whitespace().count() < 540,
            "{} words",
            text.split_whitespace().count()
        );
    }
}
