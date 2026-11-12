//! Reads agent definitions the user keeps on disk, so a chat can run as one of them.
//!
//! Claude Code keeps them as markdown with YAML frontmatter (`.claude/agents/*.md`), Codex as
//! TOML (`.codex/agents/*.toml`). Only `name` and `description` are needed, so these are read
//! line by line instead of through a full YAML/TOML parser.

use std::fs;
use std::path::{Path, PathBuf};

use crate::domain::agent::AgentChoice;

const MAX_DEPTH: usize = 3;
const MAX_FILES: usize = 200;

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn files_with_extension(dir: &Path, extension: &str, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if out.len() >= MAX_FILES {
            return;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() && depth < MAX_DEPTH {
            files_with_extension(&path, extension, depth + 1, out);
        } else if kind.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some(extension)
        {
            out.push(path);
        }
    }
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    let quoted = value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')));
    if quoted {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

/// Value of `key:` / `key =` on a single line, if present.
fn field(line: &str, key: &str, separator: char) -> Option<String> {
    let rest = line.strip_prefix(key)?.trim_start();
    let rest = rest.strip_prefix(separator)?;
    let value = unquote(rest);
    (!value.is_empty() && value != ">" && value != "|" && value != ">-" && value != "|-")
        .then_some(value)
}

fn parse_markdown(text: &str) -> Option<AgentChoice> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let (mut name, mut description) = (None, None);
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if name.is_none() {
            name = field(line, "name", ':');
        }
        if description.is_none() {
            description = field(line, "description", ':');
        }
    }
    let name = name?;
    Some(AgentChoice {
        id: name.clone(),
        label: name,
        description,
    })
}

fn parse_toml(text: &str) -> Option<AgentChoice> {
    let (mut name, mut description) = (None, None);
    for line in text.lines() {
        let line = line.trim();
        // Only top-level keys: stop at the first table header.
        if line.starts_with('[') {
            break;
        }
        if name.is_none() {
            name = field(line, "name", '=');
        }
        if description.is_none() {
            description = field(line, "description", '=');
        }
    }
    let name = name?;
    Some(AgentChoice {
        id: name.clone(),
        label: name,
        description,
    })
}

fn collect(
    dirs: &[PathBuf],
    extension: &str,
    parse: fn(&str) -> Option<AgentChoice>,
) -> Vec<AgentChoice> {
    let mut found: Vec<AgentChoice> = Vec::new();
    for dir in dirs {
        let mut files = Vec::new();
        files_with_extension(dir, extension, 0, &mut files);
        for file in files {
            let Ok(text) = fs::read_to_string(&file) else {
                continue;
            };
            if let Some(agent) = parse(&text) {
                // Earlier directories (the project) win over later ones (the user).
                if !found.iter().any(|item| item.id == agent.id) {
                    found.push(agent);
                }
            }
        }
    }
    found
}

pub fn claude_agents(cwd: &Path) -> Vec<AgentChoice> {
    let mut dirs = vec![cwd.join(".claude").join("agents")];
    if let Some(home) = home() {
        dirs.push(home.join(".claude").join("agents"));
    }
    collect(&dirs, "md", parse_markdown)
}

pub fn codex_agents(cwd: &Path) -> Vec<AgentChoice> {
    let mut dirs = vec![cwd.join(".codex").join("agents")];
    if let Some(home) = home() {
        dirs.push(home.join(".codex").join("agents"));
    }
    collect(&dirs, "toml", parse_toml)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ataraxia-defs-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn markdown_frontmatter_gives_name_and_description() {
        let agent = parse_markdown(
            "---\nname: code-reviewer\ndescription: \"Reviews diffs for bugs\"\ntools: Read, Grep\n---\nYou review code.",
        )
        .expect("parsed");
        assert_eq!(agent.id, "code-reviewer");
        assert_eq!(agent.description.as_deref(), Some("Reviews diffs for bugs"));
        assert!(parse_markdown("no frontmatter").is_none());
        assert!(parse_markdown("---\ndescription: x\n---").is_none());
    }

    #[test]
    fn multiline_descriptions_are_skipped_not_mangled() {
        let agent =
            parse_markdown("---\nname: a\ndescription: >\n  long text\n---").expect("parsed");
        assert_eq!(agent.description, None);
    }

    #[test]
    fn toml_reads_top_level_keys_only() {
        let agent = parse_toml(
            "name = \"reviewer\"\ndescription = \"PR reviewer\"\nmodel = \"x\"\n[features]\nname = \"nope\"",
        )
        .expect("parsed");
        assert_eq!(agent.id, "reviewer");
        assert_eq!(agent.description.as_deref(), Some("PR reviewer"));
    }

    #[test]
    fn project_definitions_win_and_nested_folders_are_found() {
        let project = temp_dir("project");
        let nested = project.join(".claude/agents/team");
        fs::create_dir_all(&nested).expect("dirs");
        fs::write(
            nested.join("a.md"),
            "---\nname: shared\ndescription: from project\n---\n",
        )
        .expect("write");
        let other = temp_dir("user");
        fs::write(
            other.join("b.md"),
            "---\nname: shared\ndescription: from user\n---\n",
        )
        .expect("write");
        fs::write(other.join("c.md"), "---\nname: only-user\n---\n").expect("write");

        let found = collect(
            &[project.join(".claude/agents"), other.clone()],
            "md",
            parse_markdown,
        );
        let names: Vec<_> = found.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(names, ["shared", "only-user"]);
        assert_eq!(found[0].description.as_deref(), Some("from project"));
    }
}
