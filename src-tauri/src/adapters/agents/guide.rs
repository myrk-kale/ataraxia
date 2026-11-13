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
    ("tools.md", include_str!("../../../guide/tools.md")),
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
         - Only once the developer says yes, or asks for any of them, read {} (it says what each is and how to use the ataraxia_* tools), then do what they chose. Do not read it before.\n\
         The developer's message follows.\n\n",
        index.display()
    )
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
        // The pages the index names all exist.
        let readme = std::fs::read_to_string(&index).expect("index");
        for (name, _) in FILES.iter().filter(|(name, _)| *name != "README.md") {
            assert!(readme.contains(name), "{name} is not listed in the index");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_prompt_stays_short() {
        let text = preamble(Path::new("/data/guide/README.md"));
        assert!(
            text.split_whitespace().count() < 190,
            "{} words",
            text.split_whitespace().count()
        );
    }
}
