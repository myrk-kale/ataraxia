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
    ("review.md", include_str!("../../../guide/review.md")),
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
         - Only once the developer says yes, or asks for any of them, read {} (it says what each is and how to call the API), then do what they chose. Do not read it before.\n\
         - When the developer asks for a diagram and does not say which kind, ask first, in their language, whether they want a Flow diagram (saved in Ataraxia's Flow tab) or a Mermaid diagram (a mermaid code block in your reply), and wait for the answer. Do not choose for them. If the request already says which, or says \"Flow\" or \"Mermaid\", do not ask.\n\
         - The way to act on Ataraxia is its local HTTP API, called from bash with curl as that guide explains, using $ATARAXIA_API_URL, $ATARAXIA_API_TOKEN and $ATARAXIA_SESSION_ID from your environment. There are no tools for it.\n\
         The developer's message follows.\n\n",
        index.display()
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
        assert!(prompt.contains("Flow diagram") && prompt.contains("Mermaid diagram"));
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
    fn a_request_for_a_diagram_with_no_kind_is_answered_with_a_question_and_not_a_choice() {
        let text = preamble(Path::new("/data/guide/README.md"));
        let line = text
            .lines()
            .find(|line| line.contains("asks for a diagram"))
            .expect("a line about diagrams");
        assert!(line.contains("ask first"));
        assert!(line.contains("Flow diagram"));
        assert!(line.contains("Mermaid diagram"));
        assert!(line.contains("Do not choose for them"));
        // And it does not ask when the kind was already said.
        assert!(line.contains("do not ask"));
    }

    #[test]
    fn the_prompt_stays_short() {
        let text = preamble(Path::new("/data/guide/README.md"));
        assert!(
            text.split_whitespace().count() < 240,
            "{} words",
            text.split_whitespace().count()
        );
    }
}
